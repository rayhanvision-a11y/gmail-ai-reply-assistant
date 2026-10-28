/**
 * Gmail AI Reply Assistant - Content Script
 * High-Impact Features:
 * - Smart Reply Chips (Instant 1-click contextual generation)
 * - Length Selector (Short, Medium, Long)
 * - Polish / Rewrite Mode for existing drafts
 * - Try Another Version & Undo
 * - Rock-solid DOM insertion & error handling
 */

(function () {
  'use strict';

  if (window.__GMAIL_AI_REPLY_INJECTED__) return;
  window.__GMAIL_AI_REPLY_INJECTED__ = true;

  console.log('[AI Assistant] Content script initialized');

  // State & Persistent Preferences
  let lastParams = null;
  let activeLength = 'medium';
  let activeLanguage = 'auto';
  let cachedUserContext = '';
  let cachedMeetingLink = '';
  let defaultSummaryLanguage = 'bn';

  // Load saved preferences from chrome.storage
  chrome.storage.local.get(['preferredLanguage', 'defaultLength', 'userContext', 'meetingLink', 'summaryLanguage'], (res) => {
    if (res && res.preferredLanguage) activeLanguage = res.preferredLanguage;
    if (res && res.defaultLength) activeLength = res.defaultLength;
    if (res && res.userContext) cachedUserContext = res.userContext;
    if (res && res.meetingLink) cachedMeetingLink = res.meetingLink;
    if (res && res.summaryLanguage) defaultSummaryLanguage = res.summaryLanguage;
    else if (res && res.preferredLanguage === 'en') defaultSummaryLanguage = 'en';
  });

  // Keep state live when updated from popup
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.preferredLanguage) activeLanguage = changes.preferredLanguage.newValue;
      if (changes.defaultLength) activeLength = changes.defaultLength.newValue;
      if (changes.userContext) cachedUserContext = changes.userContext.newValue;
      if (changes.meetingLink) cachedMeetingLink = changes.meetingLink.newValue;
      if (changes.summaryLanguage) defaultSummaryLanguage = changes.summaryLanguage.newValue;
    });
  }

  // When the extension is reloaded/updated, this tab's content script keeps running
  // but chrome.runtime loses its id — any sendMessage then throws
  // "Extension context invalidated". Detect it, stop observing, and tell the user.
  const isExtensionAlive = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  };

  function safeSendMessage(payload, cb) {
    if (!isExtensionAlive()) {
      try { observer.disconnect(); } catch (_) {}
      showToast('⚠️ Extension was reloaded — please refresh this Gmail tab (F5).');
      if (cb) cb(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('[AI Assistant] sendMessage error:', err.message);
          if (/context invalidated|receiving end/i.test(err.message || '')) {
            showToast('⚠️ Extension was reloaded — please refresh this Gmail tab (F5).');
          }
          if (cb) cb(null);
          return;
        }
        if (cb) cb(response);
      });
    } catch (e) {
      console.warn('[AI Assistant] sendMessage threw:', e);
      showToast('⚠️ Extension was reloaded — please refresh this Gmail tab (F5).');
      if (cb) cb(null);
    }
  }

  // Active modal tracking & clean dismissal
  let currentActiveModal = null;
  let currentOutsideClickListener = null;

  function closeActiveModal() {
    if (currentOutsideClickListener) {
      document.removeEventListener('pointerdown', currentOutsideClickListener, true);
      document.removeEventListener('click', currentOutsideClickListener, true);
      currentOutsideClickListener = null;
    }
    if (currentActiveModal) {
      try { currentActiveModal.remove(); } catch (_) {}
      currentActiveModal = null;
    }
    const leftovers = document.querySelectorAll('.gmail-ai-modal-card');
    leftovers.forEach(el => el.remove());
  }

  // Watch for Gmail compose windows dynamically.
  // Uses responsive 40ms debounce for instantaneous button appearance.
  let scanScheduled = false;
  const scheduleScan = () => {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => {
      scanScheduled = false;
      checkAndInjectButtons();
    }, 40);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Periodic fallback scan + hashchange listeners for Gmail SPA navigation
  setInterval(checkAndInjectButtons, 1500);
  window.addEventListener('hashchange', checkAndInjectButtons);
  window.addEventListener('popstate', checkAndInjectButtons);

  // Initial immediate scan
  checkAndInjectButtons();

  // Keyboard shortcut (Ctrl/Cmd+Shift+R): find any visible compose and open our modal.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'OPEN_AI_MODAL') {
      const btn = document.querySelector('.gmail-ai-reply-btn');
      const toolbar = btn ? (btn.closest('table.aoP, form, div[role="dialog"], .M9') || btn.parentElement) : null;
      if (btn && toolbar) {
        toggleAiModal(toolbar, btn);
      }
    }
  });


  /**
   * Cleans up ANY button that is not inside an active email compose window
   * directly beside a real Send button, or inside a Google Chat composer pill.
   */
  function cleanupStrayButtons() {
    document.querySelectorAll('.gmail-ai-reply-btn').forEach(btn => {
      // 1. Must never be in left navigation rail or top global bar
      if (btn.closest('[role="navigation"], .wT, .aeN, header[role="banner"], .gb_7a')) {
        btn.remove();
        return;
      }

      // 2. Chat Button validation
      if (btn.classList.contains('gmail-ai-chat-btn')) {
        const composer = btn.closest('div[role="region"], div[data-chat-room-id], c-wiz, div.HH22ic, [data-p]') || btn.parentElement;
        const hasChatTextbox = composer?.querySelector('div[role="textbox"][contenteditable="true"]');

        if (!composer || !hasChatTextbox) {
          btn.remove();
          return;
        }

        // Must NOT be stuck inside the send button container / airplane box
        const inSendBox = btn.parentElement?.querySelector('[aria-label*="Send message" i], [data-tooltip*="Send message" i]');
        if (inSendBox && btn.parentElement.children.length <= 3 && !btn.parentElement.classList.contains('gmail-ai-chat-suggestion-row')) {
          btn.remove();
          return;
        }

        // Must NOT be inside email compose
        if (btn.closest('table.aoP, .aoP, .M9, .nH.Hd, form.b7, div[aria-label*="Message Body" i]')) {
          btn.remove();
          return;
        }

        return; // Valid chat button!
      }

      // 3. Email Button validation
      const parent = btn.parentElement;
      const grandParent = parent?.parentElement;
      const sendNearby = parent?.querySelector('[role="button"][data-tooltip*="Send" i], [role="button"][aria-label*="Send" i], [role="button"].aoO') ||
                         grandParent?.querySelector('[role="button"][data-tooltip*="Send" i], [role="button"][aria-label*="Send" i], [role="button"].aoO');

      if (!sendNearby) {
        btn.remove();
      }
    });
  }

  /**
   * Main scan function: scans both Gmail email compose and Google Chat windows
   */
  function checkAndInjectButtons() {
    cleanupStrayButtons();
    checkAndInjectEmailButtons();
    checkAndInjectChatButtons();
  }

  /**
   * Scans DOM for Gmail Email Send buttons with universal support for:
   * 1. New Compose Window toolbar (beside Send button)
   * 2. Email Thread Reply inline toolbar (beside Send button in new & classic UI)
   * NEVER touches email thread headers, top bars, or inbox lists.
   */
  function checkAndInjectEmailButtons() {
    // Find all Send buttons across Gmail
    const sendBtns = document.querySelectorAll(
      '[role="button"][data-tooltip*="Send" i]:not([aria-label*="feedback" i]), ' +
      '[role="button"][aria-label*="Send" i]:not([aria-label*="feedback" i]), ' +
      '[role="button"].aoO'
    );

    sendBtns.forEach(sendBtn => {
      // Safety guard: Must not be our own button or inside our modal
      if (sendBtn.closest('.gmail-ai-modal-card')) return;
      if (sendBtn.closest('[role="navigation"], .wT, .aeN')) return;

      // Do not process Chat send buttons in email injector
      const label = (sendBtn.getAttribute('aria-label') || '') + ' ' + (sendBtn.getAttribute('data-tooltip') || '');
      if (/send message/i.test(label)) return;
      if (sendBtn.closest('div[data-chat-room-id], c-wiz[data-topic-id]')) return;

      // Locate the outer split-button element so our button sits right beside [Send | ▼]
      let anchor = sendBtn;
      let curr = sendBtn;
      while (curr && curr.parentElement && curr.parentElement !== document.body) {
        if (curr.parentElement.querySelector('[aria-label*="More send options" i], [data-tooltip*="More send options" i]')) {
          anchor = curr.parentElement;
          break;
        }
        if (curr.classList.contains('T-I-J3') || curr.parentElement.classList.contains('T-I-J3')) {
          anchor = curr.classList.contains('T-I-J3') ? curr : curr.parentElement;
          break;
        }
        if (curr.tagName === 'TD') {
          anchor = curr;
          break;
        }
        curr = curr.parentElement;
      }

      const toolbar = anchor.parentElement || sendBtn.parentElement;
      if (!toolbar) return;

      // Prevent duplicate injection in the same toolbar
      if (toolbar.querySelector('.gmail-ai-reply-btn') || anchor.querySelector?.('.gmail-ai-reply-btn')) {
        return;
      }

      // Find the compose root container to pass to modal
      const composeRoot = sendBtn.closest('table.aoP, form, div[role="region"], div[role="dialog"], .M9, .nH.Hd') || toolbar;

      const aiBtn = createAiReplyButton(composeRoot, false /* isChat = false */);

      // In classic table compose: append to TD. In new flexbox: insert directly after Send group
      if (anchor.tagName === 'TD') {
        anchor.appendChild(aiBtn);
      } else if (anchor.parentElement) {
        anchor.parentElement.insertBefore(aiBtn, anchor.nextSibling);
      } else {
        toolbar.appendChild(aiBtn);
      }
    });
  }

  /**
   * Scans DOM for Google Chat composer (both standalone chat.google.com and inside Gmail).
   * Injects the AI Reply button right BEFORE Google's Smart Reply suggestion chips in middle alignment.
   * If suggestions aren't present yet, it cleanly sits in a suggestion row right above the chat input pill.
   */
  function checkAndInjectChatButtons() {
    const textboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');

    textboxes.forEach(textbox => {
      // Exclude Gmail email compose
      if (textbox.closest('table.aoP, .aoP, .M9, .nH.Hd, form.b7, div[aria-label*="Message Body" i]')) return;
      // Exclude search or our modal
      if (textbox.closest('.gmail-ai-modal-card') || textbox.getAttribute('name') === 'q') return;

      const composer = textbox.closest('div[role="region"], div[data-chat-room-id], c-wiz, form') || textbox.parentElement?.parentElement;
      if (!composer) return;

      // Locate the input pill container (holds '+', textbox, formatting, emoji, mic, send)
      let inputPill = textbox;
      let curr = textbox;
      while (curr && curr.parentElement && curr.parentElement !== composer) {
        if (curr.parentElement.querySelector('[aria-label*="Send message" i], [data-tooltip*="Send message" i], [aria-label*="format" i], [aria-label*="emoji" i]')) {
          inputPill = curr.parentElement;
          break;
        }
        curr = curr.parentElement;
      }

      // 1. Look for existing Smart Reply suggestion chips (e.g. "Good, and you?", "Fine", etc.)
      const allButtons = Array.from(composer.querySelectorAll('button, div[role="button"]'));
      const candidateChips = allButtons.filter(b => {
        if (b.classList.contains('gmail-ai-reply-btn')) return false;
        if (b.closest('.gmail-ai-modal-card')) return false;
        // Must be outside the input pill
        if (inputPill && inputPill.contains(b)) return false;
        // Must contain suggestion text
        const txt = (b.innerText || '').trim();
        if (txt.length < 2 || txt.length > 50) return false;
        const lower = txt.toLowerCase();
        if (['today', 'yesterday', 'history is on', 'history is off'].includes(lower)) return false;
        return true;
      });

      const existingBtn = composer.querySelector('.gmail-ai-chat-btn');

      if (candidateChips.length > 0) {
        const firstChip = candidateChips[0];
        const chipContainer = firstChip.parentElement;

        if (existingBtn) {
          // If already in chipContainer directly before firstChip, nothing to do
          if (existingBtn.parentElement === chipContainer && existingBtn.nextElementSibling === firstChip) {
            return;
          }
          // Move existing button to right before the first suggestion chip
          chipContainer.insertBefore(existingBtn, firstChip);
          return;
        }

        const aiBtn = createAiReplyButton(composer, true /* isChat = true */);
        chipContainer.insertBefore(aiBtn, firstChip);
        return;
      }

      // 2. If no suggestion chips are currently present, place in row directly above the input pill
      if (inputPill && inputPill.parentElement) {
        let suggestionRow = composer.querySelector('.gmail-ai-chat-suggestion-row');
        if (!suggestionRow) {
          suggestionRow = document.createElement('div');
          suggestionRow.className = 'gmail-ai-chat-suggestion-row';
          inputPill.parentElement.insertBefore(suggestionRow, inputPill);
        }

        if (!suggestionRow.querySelector('.gmail-ai-chat-btn')) {
          if (existingBtn) {
            suggestionRow.appendChild(existingBtn);
          } else {
            const aiBtn = createAiReplyButton(composer, true /* isChat = true */);
            suggestionRow.appendChild(aiBtn);
          }
        }
      }
    });
  }

  /**
   * Creates the primary "✨ AI Reply" button with bulletproof event handling.
   */
  function createAiReplyButton(toolbar, isChat = false) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gmail-ai-reply-btn' + (isChat ? ' gmail-ai-chat-btn' : '');
    btn.title = isChat ? 'AI Chat Assistant (Fast & Smart DM Reply)' : 'AI Reply Assistant (Gemini • ChatGPT • Claude)';
    btn.__isChat = isChat;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/>
      </svg>
      <span>AI Reply</span>
    `;

    // CRITICAL: Stop Gmail's toolbar container from stealing focus or triggering
    // blur/focus reflows on mousedown that cause Chrome to drop the click event.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);

    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    }, true);

    let lastToggleTime = 0;
    const handleTrigger = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      const now = Date.now();
      if (now - lastToggleTime < 300) return; // Prevent double trigger
      lastToggleTime = now;
      toggleAiModal(toolbar, btn, isChat);
    };

    // Use capture phase so no Gmail parent handler can intercept or swallow clicks
    btn.addEventListener('click', handleTrigger, true);
    btn.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        handleTrigger(e);
      }
    }, true);

    return btn;
  }

  /**
   * Opens or closes the AI Modal Card with smart viewport positioning
   */
  function toggleAiModal(toolbar, btn, isChat = false) {
    const existingModal = document.querySelector('.gmail-ai-modal-card');
    if (existingModal) {
      const isSameButton = existingModal.__sourceBtn === btn;
      closeActiveModal();
      if (isSameButton) {
        // Toggle closed when clicking the same button
        return;
      }
    }

    closeActiveModal(); // Ensure any stray modals and old document listeners are eliminated

    const modal = createAiModalCard(toolbar, isChat);
    modal.__sourceBtn = btn;
    currentActiveModal = modal;

    // Fixed positioning calculation relative to button
    const rect = btn.getBoundingClientRect();
    modal.style.position = 'fixed';

    const modalWidth = 430;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    // Prefer positioning above the button (Gmail compose is typically docked at bottom)
    if (spaceAbove >= 400 || spaceAbove >= spaceBelow) {
      const bottomPos = window.innerHeight - rect.top + 8;
      modal.style.bottom = `${Math.max(12, Math.min(window.innerHeight - 60, bottomPos))}px`;
      modal.style.top = 'auto';
    } else {
      const topPos = rect.bottom + 8;
      modal.style.top = `${Math.max(12, Math.min(window.innerHeight - 60, topPos))}px`;
      modal.style.bottom = 'auto';
    }

    // Keep horizontally within visible viewport bounds
    const maxLeft = Math.max(10, window.innerWidth - modalWidth - 20);
    const leftPos = Math.min(Math.max(10, rect.left), maxLeft);
    modal.style.left = `${leftPos}px`;

    document.body.appendChild(modal);

    // Setup outside click dismissal after brief settle delay
    setTimeout(() => {
      if (!currentActiveModal || currentActiveModal !== modal) return;
      currentOutsideClickListener = (evt) => {
        if (!modal.isConnected) {
          closeActiveModal();
          return;
        }
        if (
          modal.contains(evt.target) ||
          btn.contains(evt.target) ||
          evt.target.closest('.gmail-ai-reply-btn') ||
          evt.target.closest('.gmail-ai-floating-actions')
        ) {
          return;
        }
        closeActiveModal();
      };

      document.addEventListener('pointerdown', currentOutsideClickListener, true);
    }, 80);
  }

  /**
   * Creates the complete Modal UI (Ultra-Modern Linear/Notion Style with Bottom Tabs)
   */
  function createAiModalCard(toolbar, isChat = false) {
    const emailData = isChat ? extractChatData(toolbar) : extractIncomingEmailData(toolbar);
    emailData.isChat = isChat;
    const existingDraftText = getComposeDraftText(toolbar, isChat);
    const isNewCompose = !isChat && !(emailData.body && emailData.body.trim().length >= 5);

    const card = document.createElement('div');
    card.className = 'gmail-ai-modal-card';

    let activeTab = 'generate'; // Always default to ✍️ New Reply on modal open
    let selectedTone = isChat ? 'friendly' : 'professional';

    card.innerHTML = `
      <!-- Modern Header -->
      <div class="gmail-ai-modal-header">
        <div class="gmail-ai-header-left">
          <div class="gmail-ai-icon-badge" style="${isChat ? 'background: linear-gradient(135deg, #10b981 0%, #059669 100%);' : ''}">
            <svg viewBox="0 0 24 24">
              <path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z"/>
            </svg>
          </div>
          <div>
            <div class="gmail-ai-header-title">${isChat ? 'AI Chat Assistant' : 'AI Reply Assistant'}</div>
          </div>
          ${cachedUserContext ? `<span class="gmail-ai-profile-badge" title="${escapeHtml(cachedUserContext)}"><span>👤</span> Role Active</span>` : ''}
          ${emailData.sender ? `<span class="gmail-ai-recipient-tag" title="${escapeHtml(emailData.sender)}">👤 ${escapeHtml(truncate(emailData.sender, 22))}</span>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <button type="button" class="gmail-ai-modal-close-btn" title="Close (Esc)">&times;</button>
        </div>
      </div>

      <!-- Scrollable Main Content -->
      <div class="gmail-ai-modal-scroll">
        <!-- Feature 1: Summary Box Container (Dynamic) -->
        <div id="gmail-ai-summary-container" style="display: none; margin-bottom: 10px;"></div>

        ${isNewCompose ? `<div class="gmail-ai-newmail-hint">✍️ <strong>New Email Mode</strong> — No incoming email detected. Describe what you want to say and AI will write a complete email from scratch.</div>` : ''}

        <!-- Modern Prompt Box -->
        <div class="gmail-ai-prompt-box">
          <textarea
            class="gmail-ai-textarea"
            placeholder="${isChat ? 'Type instructions (e.g. tell him I will check and reply in 10 mins)...' : (isNewCompose ? 'What should this email say? (e.g. ask John for Friday meeting agenda, confirm invoice received, request vacation leave)...' : 'Type instructions or notes (e.g. confirm 3 PM call)...')}"
          ></textarea>
        </div>

        <!-- TAB 1: GENERATE NEW REPLY (Selected by default) -->
        <div id="tab-generate-panel" style="display: block;">
          <!-- Dual Dropdowns Row: Quick Smart Replies (50%) & Tone & Voice (50%) -->
          <div class="gmail-ai-dual-dropdowns-row">
            <!-- 50%: Quick Smart Replies Dropdown -->
            <div class="gmail-ai-dropdown-col">
              <label class="gmail-ai-dropdown-label" for="gmail-ai-intent-select">
                <span>⚡ Smart Reply Intent</span>
              </label>
              <div class="gmail-ai-dropdown-wrap">
                <select class="gmail-ai-dropdown-select" id="gmail-ai-intent-select">
                  <option value="" selected>⚡ Auto / Custom Only</option>
                  ${isChat ? `
                    <option value="Warmly greet, acknowledge, and ask how you can assist">👋 Quick Hello & Greet</option>
                    <option value="Acknowledge, agree positively, and confirm sounds great">👍 Sounds Good / Agree</option>
                    <option value="Let them know you are actively working on it right now">⚡ On It! (In Progress)</option>
                    <option value="Acknowledge message and let them know you will check and reply shortly">⏳ Check & Reply Soon</option>
                    <option value="meeting">📅 Propose Quick Call</option>
                    <option value="Friendly short thank you and appreciation">🙏 Thanks & Appreciation</option>
                  ` : `
                    <option value="Acknowledge with sincere thanks and confirm receipt">🙏 Thanks & Received</option>
                    <option value="Confirm agreement, accept positively, and outline next steps">👍 Confirm & Agree</option>
                    <option value="meeting">📅 Propose Meeting</option>
                    <option value="Provide a direct and clear status update">⚡ Quick Status Update</option>
                    <option value="Politely and courteously decline with sincere gratitude">❌ Polite Decline</option>
                    <option value="Politely request additional details and clarification">❓ Request Details</option>
                    <option value="Courteously follow up on previous discussion">🤝 Follow Up</option>
                  `}
                </select>
                <svg class="gmail-ai-dropdown-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 8l4 4 4-4"/>
                </svg>
              </div>
            </div>

            <!-- 50%: Tone & Voice Dropdown -->
            <div class="gmail-ai-dropdown-col">
              <label class="gmail-ai-dropdown-label" for="gmail-ai-tone-select">
                <span>🎭 Tone & Voice</span>
              </label>
              <div class="gmail-ai-dropdown-wrap">
                <select class="gmail-ai-dropdown-select" id="gmail-ai-tone-select">
                  <option value="professional" ${selectedTone === 'professional' ? 'selected' : ''}>👔 Professional</option>
                  <option value="friendly" ${selectedTone === 'friendly' ? 'selected' : ''}>😊 Warm & Friendly</option>
                  <option value="quick" ${selectedTone === 'quick' ? 'selected' : ''}>⚡ Direct & Concise</option>
                  <option value="accept" ${selectedTone === 'accept' ? 'selected' : ''}>🤝 Accept & Confirm</option>
                  <option value="executive" ${selectedTone === 'executive' ? 'selected' : ''}>👑 Executive & Formal</option>
                  <option value="casual" ${selectedTone === 'casual' ? 'selected' : ''}>☕ Casual & Relaxed</option>
                </select>
                <svg class="gmail-ai-dropdown-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 8l4 4 4-4"/>
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: POLISH EXISTING DRAFT -->
        <div id="tab-polish-panel" style="display: none;">
          <div class="gmail-ai-dropdown-col" style="margin-bottom: 8px;">
            <label class="gmail-ai-dropdown-label" for="gmail-ai-polish-select">
              <span>🪄 Polish Mode</span>
              <span style="font-weight: normal; text-transform: none; font-size: 10px; color: ${existingDraftText ? '#16a34a' : '#ef4444'};">
                ${existingDraftText ? '✓ Ready to polish' : 'Write text in compose first'}
              </span>
            </label>
            <div class="gmail-ai-dropdown-wrap">
              <select class="gmail-ai-dropdown-select" id="gmail-ai-polish-select">
                <option value="professional" selected>👔 Executive & Professional</option>
                <option value="grammar">✨ Fix Grammar & Clarity</option>
                <option value="short">🤏 Make Shorter & Direct</option>
                <option value="friendly">😊 Warm & Courteous</option>
                <option value="expand">📝 Expand & Elaborate</option>
              </select>
              <svg class="gmail-ai-dropdown-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 8l4 4 4-4"/>
              </svg>
            </div>
          </div>
        </div>

        <!-- Feature 3: Variations Container (Dynamic) -->
        <div id="gmail-ai-variations-container" style="display: none; margin-top: 10px;"></div>
      </div>

      <!-- Meta Bar: Segmented Length Pills, 3-Draft Toggle & Persistent Language -->
      <div class="gmail-ai-meta-bar">
        <div class="gmail-ai-meta-left">
          <div class="gmail-ai-seg-pills" id="modal-len-pills">
            <button type="button" class="gmail-ai-seg-btn ${activeLength === 'short' ? 'active' : ''}" data-len="short">Short</button>
            <button type="button" class="gmail-ai-seg-btn ${activeLength === 'medium' ? 'active' : ''}" data-len="medium">Normal</button>
            <button type="button" class="gmail-ai-seg-btn ${activeLength === 'long' ? 'active' : ''}" data-len="long">Detailed</button>
          </div>
        </div>

        <div class="gmail-ai-meta-right" style="display: flex; align-items: center; gap: 8px;">
          <label class="gmail-ai-multidraft-toggle" title="Generate 3 distinct drafts: Direct, Executive & Warm">
            <input type="checkbox" id="gmail-ai-multi-chk">
            <span>3 Drafts</span>
          </label>
          <div class="gmail-ai-lang-wrapper">
            <select class="gmail-ai-select" id="gmail-ai-lang" title="Language is permanently remembered">
              <option value="auto" ${activeLanguage === 'auto' ? 'selected' : ''}>🌐 Auto</option>
              <option value="en" ${activeLanguage === 'en' ? 'selected' : ''}>English</option>
              <option value="bn" ${activeLanguage === 'bn' ? 'selected' : ''}>বাংলা (Bengali)</option>
              <option value="hi" ${activeLanguage === 'hi' ? 'selected' : ''}>हिन्दी (Hindi)</option>
              <option value="es" ${activeLanguage === 'es' ? 'selected' : ''}>Español</option>
              <option value="fr" ${activeLanguage === 'fr' ? 'selected' : ''}>Français</option>
              <option value="de" ${activeLanguage === 'de' ? 'selected' : ''}>Deutsch</option>
              <option value="ar" ${activeLanguage === 'ar' ? 'selected' : ''}>العربية</option>
            </select>
            <span class="gmail-ai-select-arrow">▼</span>
          </div>
        </div>
      </div>

      <!-- Dedicated Action Button Bar (Full Width, Never Cut Off) -->
      <div class="gmail-ai-action-bar">
        ${isNewCompose ? '' : `<button type="button" class="gmail-ai-tldr-toggle-btn gmail-ai-tldr-footer-btn" id="gmail-ai-tldr-btn" title="${isChat ? 'Summarize conversation history' : 'Summarize incoming email'}">
          📋 Summary
        </button>`}
        <button type="button" class="gmail-ai-gen-btn-full" id="gmail-ai-submit-btn">
          ${activeTab === 'polish' ? '🪄 Polish Draft' : '✨ Generate Reply'}
        </button>
      </div>

      <!-- Bottom Navigation Tabs ("niche tab thakbe") -->
      <div class="gmail-ai-bottom-nav-tabs">
        <button type="button" class="gmail-ai-bottom-nav-tab ${activeTab === 'generate' ? 'active' : ''}" data-tab="generate">
          ✍️ New Reply
        </button>
        <button type="button" class="gmail-ai-bottom-nav-tab ${activeTab === 'polish' ? 'active' : ''}" data-tab="polish">
          🪄 Polish Draft ${existingDraftText ? '<span class="tab-badge"></span>' : ''}
        </button>
      </div>

      <!-- Loading Overlay -->
      <div class="gmail-ai-loading-overlay" style="display: none;">
        <div class="gmail-ai-spinner"></div>
        <div id="gmail-ai-loading-text">Generating reply...</div>
      </div>
    `;

    const closeBtn = card.querySelector('.gmail-ai-modal-close-btn');
    const genPanel = card.querySelector('#tab-generate-panel');
    const polishPanel = card.querySelector('#tab-polish-panel');
    const submitBtn = card.querySelector('#gmail-ai-submit-btn');
    const textarea = card.querySelector('.gmail-ai-textarea');
    const langSelect = card.querySelector('#gmail-ai-lang');
    const bottomTabs = card.querySelectorAll('.gmail-ai-bottom-nav-tab');
    const intentSelect = card.querySelector('#gmail-ai-intent-select');
    const toneSelect = card.querySelector('#gmail-ai-tone-select');

    // Auto-focus the modern prompt textarea
    setTimeout(() => textarea.focus(), 60);

    // Close button
    closeBtn.addEventListener('click', () => closeActiveModal());

    // Switch bottom tabs
    function setTab(tabName) {
      activeTab = tabName;
      bottomTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabName);
      });

      if (tabName === 'generate') {
        genPanel.style.display = 'block';
        polishPanel.style.display = 'none';
        submitBtn.innerHTML = '✨ Generate Reply';
      } else {
        genPanel.style.display = 'none';
        polishPanel.style.display = 'block';
        submitBtn.innerHTML = '🪄 Polish Draft';
      }
    }

    bottomTabs.forEach(tab => {
      tab.addEventListener('click', () => setTab(tab.dataset.tab));
    });

    // Language Selection: Permanently saved
    langSelect.addEventListener('change', () => {
      activeLanguage = langSelect.value;
      chrome.storage.local.set({ preferredLanguage: activeLanguage }, () => {
        console.log('[AI Assistant] Language permanently saved:', activeLanguage);
      });
      showToast('🌐 Language saved: ' + langSelect.options[langSelect.selectedIndex].text);
    });

    // Length Toggle Pills: Permanently saved
    const lenPills = card.querySelectorAll('#modal-len-pills .gmail-ai-seg-btn');
    lenPills.forEach(pill => {
      pill.addEventListener('click', () => {
        lenPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeLength = pill.dataset.len;
        chrome.storage.local.set({ defaultLength: activeLength });
      });
    });

    // Feature 1: TL;DR / Email Summary with Bengali & English Language Switching
    const tldrBtn = card.querySelector('#gmail-ai-tldr-btn');
    const summaryContainer = card.querySelector('#gmail-ai-summary-container');
    const promptTextarea = card.querySelector('.gmail-ai-textarea');

    if (tldrBtn && summaryContainer) {
      let activeSumLang = defaultSummaryLanguage || 'bn';
      const cachedSummaries = {}; // { bn: '...', en: '...', both: '...' }

      const renderSummaryUI = (isLoading = false, errorMsg = null) => {
        const currentSummary = cachedSummaries[activeSumLang] || '';
        
        let bodyHtml = '';
        if (isLoading) {
          const loadingText = activeSumLang === 'bn' 
            ? 'মেইলটি বিশ্লেষণ করে বাংলা সারসংক্ষেপ তৈরি হচ্ছে...'
            : (activeSumLang === 'both' ? 'Generating summary in both বাংলা & English...' : 'Analyzing email and generating English summary...');
          bodyHtml = `
            <div class="gmail-ai-summary-loading">
              <span style="display:inline-block; width:12px; height:12px; border:2px solid #cbd5e1; border-top-color:#6366f1; border-radius:50%; animation:aiSpin .7s linear infinite; margin-right:6px; vertical-align:middle;"></span>
              <span>${loadingText}</span>
            </div>
          `;
        } else if (errorMsg) {
          bodyHtml = `<div style="color: #ef4444; font-size: 11.5px; padding: 4px 0;">❌ ${escapeHtml(errorMsg)}</div>`;
        } else {
          bodyHtml = `
            ${renderStructuredSummary(currentSummary)}
            <div class="gmail-ai-summary-footer">
              <button type="button" class="gmail-ai-sum-action-btn" id="gmail-ai-sum-copy">📋 Copy</button>
              <button type="button" class="gmail-ai-sum-action-btn" id="gmail-ai-sum-use">✍️ Use as Reply Notes</button>
            </div>
          `;
        }

        summaryContainer.innerHTML = `
          <div class="gmail-ai-summary-box">
            <div class="gmail-ai-summary-header">
              <div class="gmail-ai-summary-title">
                <span>⚡</span>
                <span>Email Summary</span>
              </div>
              <div class="gmail-ai-sum-lang-wrap">
                <select class="gmail-ai-sum-lang-select" id="gmail-ai-sum-lang-select" title="Summary language">
                  <option value="bn" ${activeSumLang === 'bn' ? 'selected' : ''}>🇧🇩 বাংলা</option>
                  <option value="en" ${activeSumLang === 'en' ? 'selected' : ''}>🇺🇸 English</option>
                  <option value="both" ${activeSumLang === 'both' ? 'selected' : ''}>🌐 Both</option>
                </select>
                <span class="gmail-ai-sum-lang-arrow">▼</span>
              </div>
              <button type="button" class="gmail-ai-summary-close" title="Close">&times;</button>
            </div>
            <div class="gmail-ai-summary-body">
              ${bodyHtml}
            </div>
          </div>
        `;

        // Bind language dropdown
        const langSel = summaryContainer.querySelector('#gmail-ai-sum-lang-select');
        if (langSel) {
          langSel.addEventListener('change', (e) => {
            e.stopPropagation();
            const newLang = langSel.value;
            if (newLang === activeSumLang && !isLoading) return;
            activeSumLang = newLang;
            chrome.storage.local.set({ summaryLanguage: newLang });
            fetchOrShowSummary();
          });
        }

        // Bind close button
        const closeBtn = summaryContainer.querySelector('.gmail-ai-summary-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            summaryContainer.style.display = 'none';
          });
        }

        // Bind action buttons
        const copyBtn = summaryContainer.querySelector('#gmail-ai-sum-copy');
        if (copyBtn && currentSummary) {
          copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(currentSummary);
            copyBtn.textContent = '✅ Copied!';
            setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
          });
        }

        const useBtn = summaryContainer.querySelector('#gmail-ai-sum-use');
        if (useBtn && currentSummary && promptTextarea) {
          useBtn.addEventListener('click', () => {
            const firstLine = currentSummary.split('\n')[0] || currentSummary;
            const cleanShort = firstLine.replace(/^[📌🎯⏰\s]+/, '').trim();
            promptTextarea.value = promptTextarea.value 
              ? `${promptTextarea.value}\n(Context: ${cleanShort})`
              : `Context: ${cleanShort}`;
            promptTextarea.focus();
            useBtn.textContent = '✅ Added to prompt!';
            setTimeout(() => { useBtn.textContent = '✍️ Use as Reply Notes'; }, 2000);
          });
        }
      };

      const fetchOrShowSummary = () => {
        const bodyContent = (emailData.body || emailData.emailBody || '').trim();
        if (!bodyContent || bodyContent.length < 10) {
          showToast('⚠️ No incoming email message detected to summarize.');
          return;
        }

        summaryContainer.style.display = 'block';

        if (cachedSummaries[activeSumLang]) {
          renderSummaryUI(false, null);
          return;
        }

        renderSummaryUI(true, null);

        safeSendMessage({
          action: 'SUMMARIZE_EMAIL',
          data: {
            ...emailData,
            language: activeSumLang
          }
        }, (response) => {
          if (!response) {
            renderSummaryUI(false, 'No response from AI worker.');
            return;
          }
          if (response.success && response.summary) {
            cachedSummaries[activeSumLang] = response.summary;
            renderSummaryUI(false, null);
          } else {
            const err = formatProviderError(response.error || 'Failed to summarize email.');
            renderSummaryUI(false, err);
          }
        });
      };

      tldrBtn.addEventListener('click', () => {
        if (summaryContainer.style.display === 'block') {
          summaryContainer.style.display = 'none';
        } else {
          fetchOrShowSummary();
        }
      });
    }

    // Tone Select changes selectedTone
    if (toneSelect) {
      toneSelect.addEventListener('change', () => {
        selectedTone = toneSelect.value;
      });
    }

    const polishSelect = card.querySelector('#gmail-ai-polish-select');

    // Generate / Submit Button
    submitBtn.addEventListener('click', () => {
      const customNotes = textarea.value.trim();
      const currentTone = toneSelect ? toneSelect.value : selectedTone;
      const currentIntent = intentSelect ? intentSelect.value : '';

      if (activeTab === 'generate') {
        triggerReplyGeneration(card, toolbar, emailData, currentTone, currentIntent);
      } else {
        const polishMode = polishSelect ? polishSelect.value : 'professional';
        triggerPolishDraft(card, toolbar, polishMode, customNotes, isChat);
      }
    });

    // Keyboard Shortcuts: Enter submits, Shift+Enter creates a new line
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitBtn.click();
      } else if (e.key === 'Escape') {
        closeActiveModal();
      }
    });

    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeActiveModal();
    });

    return card;
  }

  /**
   * Renders the 3 AI variations tabs & preview for the user to choose from
   */
  function displayDraftVariations(card, toolbar, variations, isChat = false) {
    const container = card.querySelector('#gmail-ai-variations-container');
    if (!container) return;

    const tabLabels = ['⚡ 1. Direct', '👔 2. Executive', '🤝 3. Warm'];

    container.innerHTML = `
      <div class="gmail-ai-variations-box">
        <div class="gmail-ai-summary-header" style="color: #2563eb;">
          <span>🔀 Select from 3 Variations</span>
          <span style="font-size: 10px; color: #64748b; font-weight: normal;">Click tab to preview</span>
        </div>
        <div class="gmail-ai-var-tabs">
          ${variations.map((_, idx) => `
            <button type="button" class="gmail-ai-var-tab ${idx === 0 ? 'active' : ''}" data-vidx="${idx}">
              ${tabLabels[idx] || `Draft ${idx + 1}`}
            </button>
          `).join('')}
        </div>
        <div class="gmail-ai-var-preview" id="gmail-ai-var-preview-text"></div>
        <button type="button" class="gmail-ai-insert-var-btn" id="gmail-ai-insert-var-btn">
          <span>✓ Insert This Draft ${isChat ? 'Into Chat' : 'Into Gmail'}</span>
        </button>
      </div>
    `;
    container.style.display = 'block';

    let selectedIdx = 0;
    const previewEl = container.querySelector('#gmail-ai-var-preview-text');
    const insertBtn = container.querySelector('#gmail-ai-insert-var-btn');
    const tabs = container.querySelectorAll('.gmail-ai-var-tab');

    const updatePreview = (idx) => {
      selectedIdx = idx;
      tabs.forEach(t => t.classList.toggle('active', parseInt(t.dataset.vidx, 10) === idx));
      previewEl.textContent = variations[idx] || variations[0];
    };

    tabs.forEach(t => {
      t.addEventListener('click', () => {
        updatePreview(parseInt(t.dataset.vidx, 10));
      });
    });

    insertBtn.addEventListener('click', () => {
      const textToInsert = variations[selectedIdx] || variations[0];
      const inserted = insertTextIntoCompose(toolbar, textToInsert, isChat);
      closeActiveModal();
      if (inserted) {
        showFloatingRegenerateBar(toolbar, isChat);
        showToast('✨ Variation inserted successfully!');
      } else {
        showToast('⚠️ Could not locate reply editor.');
      }
    });

    updatePreview(0);
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /**
   * Generates reply and inserts into Gmail compose box or Google Chat
   */
  function triggerReplyGeneration(card, toolbar, emailData, tone, intentNote) {
    const isChat = !!emailData.isChat;
    const overlay = card.querySelector('.gmail-ai-loading-overlay');
    const loadText = card.querySelector('#gmail-ai-loading-text');
    const textarea = card.querySelector('.gmail-ai-textarea');
    const customNotes = textarea ? textarea.value.trim() : '';

    const multiChk = card.querySelector('#gmail-ai-multi-chk');
    const isMultiDraft = multiChk ? multiChk.checked : false;

    let computedIntent = intentNote || '';
    if (computedIntent === 'meeting') {
      computedIntent = cachedMeetingLink
        ? `Propose scheduling a meeting/call and include booking link directly: ${cachedMeetingLink}`
        : 'Propose scheduling a 20-30 minute meeting call next week and ask for their availability.';
    }

    const notesList = [];
    if (computedIntent) {
      notesList.push(`INTENT / CORE ACTION: ${computedIntent}`);
    }
    if (customNotes) {
      notesList.push(`USER SHORT SUMMARY / NOTES TO ADDRESS: ${customNotes}`);
    }
    const fullNotes = notesList.join('\n');

    if (loadText) {
      loadText.textContent = isMultiDraft ? 'Generating 3 draft variations...' : (isChat ? 'Generating quick chat reply...' : 'Generating smart reply...');
    }
    overlay.style.display = 'flex';

    const safetyTimeout = setTimeout(() => {
      overlay.style.display = 'none';
      showToast('⚠️ The request took too long. Please try again.');
    }, 25000);

    const params = {
      emailBody: emailData.body,
      sender: emailData.sender,
      subject: emailData.subject,
      tone: tone,
      length: activeLength,
      customNotes: fullNotes,
      language: activeLanguage,
      multiDraft: isMultiDraft,
      isAlternative: false,
      isChat: isChat
    };

    lastParams = params;
    console.log('[AI Assistant] Sending GENERATE_REPLY with params:', params);

    safeSendMessage({
      action: 'GENERATE_REPLY',
      data: params
    }, (response) => {
      clearTimeout(safetyTimeout);
      overlay.style.display = 'none';

      if (!response) return; // safeSendMessage already toasted

      if (response.success) {
        if (isMultiDraft && response.variations && response.variations.length > 1) {
          displayDraftVariations(card, toolbar, response.variations, isChat);
          showToast('🔀 3 Variations generated! Pick your favorite.');
          return;
        }

        if (response.replyText) {
          const inserted = insertTextIntoCompose(toolbar, response.replyText, isChat);
          closeActiveModal();
          if (inserted) {
            showFloatingRegenerateBar(toolbar, isChat);
            showToast(isChat ? '💬 Chat reply ready! Hit Enter to send.' : '✨ Reply inserted successfully!');
          } else {
            showToast('⚠️ Could not locate reply editor.');
          }
        }
      } else {
        showToast(formatProviderError(response.error));
      }
    });
  }

  /**
   * Polishes active draft
   */
  function triggerPolishDraft(card, toolbar, mode, customNotes = '', isChat = false) {
    const draftText = getComposeDraftText(toolbar, isChat);
    if (!draftText || draftText.trim().length < 4) {
      showToast('⚠️ Please write some text in the reply box first!');
      return;
    }

    const overlay = card.querySelector('.gmail-ai-loading-overlay');
    const loadText = card.querySelector('#gmail-ai-loading-text');
    const textarea = card.querySelector('.gmail-ai-textarea');
    const notes = customNotes || (textarea ? textarea.value.trim() : '');

    if (loadText) loadText.textContent = 'Polishing your draft...';
    overlay.style.display = 'flex';

    const safetyTimeout = setTimeout(() => {
      overlay.style.display = 'none';
      showToast('⚠️ Request timed out. Please try again.');
    }, 20000);

    safeSendMessage({
      action: 'POLISH_DRAFT',
      data: {
        draftText,
        mode,
        language: activeLanguage,
        customNotes: notes,
        isChat: isChat
      }
    }, (response) => {
      clearTimeout(safetyTimeout);
      overlay.style.display = 'none';

      if (!response) return;

      if (response.success && response.polishedText) {
        replaceComposeText(toolbar, response.polishedText, isChat);
        closeActiveModal();
        showFloatingRegenerateBar(toolbar, isChat);
        showToast('🪄 Draft polished successfully!');
      } else {
        showToast(formatProviderError(response.error));
      }
    });
  }

  /**
   * Floating "Try Another Version" & "Undo" Bar
   */
  function showFloatingRegenerateBar(toolbar, isChat = false) {
    const existing = toolbar.querySelector('.gmail-ai-floating-actions');
    if (existing) existing.remove();

    const bar = document.createElement('span');
    bar.className = 'gmail-ai-floating-actions';

    bar.innerHTML = `
      <button type="button" class="gmail-ai-action-chip" id="gmail-ai-regen-btn" title="Generate another version with varied phrasing">
        🔄 Try Another Version
      </button>
      <button type="button" class="gmail-ai-action-chip" id="gmail-ai-undo-btn" title="Undo inserted reply">
        ↩ Undo
      </button>
    `;

    bar.querySelector('#gmail-ai-regen-btn').addEventListener('click', () => {
      if (!lastParams) return;
      showToast('🔄 Generating alternative version...');

      lastParams.isAlternative = true;
      safeSendMessage({
        action: 'GENERATE_REPLY',
        data: lastParams
      }, (res) => {
        if (!res) return;
        if (res.success && res.replyText) {
          replaceComposeText(toolbar, res.replyText, isChat);
          showToast('✨ Alternative version inserted!');
        } else {
          showToast(formatProviderError(res.error));
        }
      });
    });

    bar.querySelector('#gmail-ai-undo-btn').addEventListener('click', () => {
      document.execCommand('undo', false, null);
      bar.remove();
      showToast('↩ Undone!');
    });

    const aiBtn = toolbar.querySelector('.gmail-ai-reply-btn');
    if (aiBtn && aiBtn.parentElement) {
      aiBtn.parentElement.appendChild(bar);
    }
  }

  /**
   * Finds the active Gmail or Google Chat compose editor contenteditable element
   */
  function findComposeEditor(toolbar, isChat = false) {
    if (isChat) {
      // Look inside toolbar or closest chat container
      const chatRoot = toolbar.closest('div[role="main"], div[role="region"], div[data-p], c-wiz, div[aria-label*="Conversation"], div.HH22ic') || toolbar.parentElement || document;
      const editor = chatRoot.querySelector('div[role="textbox"][contenteditable="true"]') ||
                     chatRoot.querySelector('div[contenteditable="true"]');
      if (editor) return editor;

      // Look if current active element is a chat textbox
      if (document.activeElement && document.activeElement.getAttribute('role') === 'textbox' && document.activeElement.isContentEditable) {
        return document.activeElement;
      }

      // Fallback: search all textboxes, pick one not in email compose
      const allTextboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
      for (let i = allTextboxes.length - 1; i >= 0; i--) {
        const tb = allTextboxes[i];
        if (!tb.closest('tr.btC, .aDh, .M9, form.b7, table.aoP, div[aria-label*="Message Body"]')) {
          return tb;
        }
      }
      return null;
    }

    // Gmail Email compose editor resolution
    let curr = toolbar.parentElement;
    while (curr && curr !== document.body) {
      const el = curr.querySelector('div[role="textbox"][contenteditable="true"], div[g_editable="true"], div[aria-label*="Message Body"]');
      if (el) return el;
      curr = curr.parentElement;
    }

    if (document.activeElement && document.activeElement.getAttribute('role') === 'textbox' && document.activeElement.isContentEditable) {
      return document.activeElement;
    }

    const all = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
    if (all.length > 0) {
      return all[all.length - 1];
    }

    return null;
  }

  /**
   * Gets current draft plain text
   */
  function getComposeDraftText(toolbar, isChat = false) {
    const editor = findComposeEditor(toolbar, isChat);
    return editor ? (editor.innerText || '').trim() : '';
  }

  /**
   * Replaces editor content
   */
  function replaceComposeText(toolbar, text, isChat = false) {
    return insertTextIntoCompose(toolbar, text, isChat);
  }

  /**
   * Inserts text into Gmail's or Google Chat's contenteditable compose box reliably
   */
  function insertTextIntoCompose(toolbar, text, isChat = false) {
    let editor = findComposeEditor(toolbar, isChat);
    if (!editor) {
      if (!isChat) {
        // Auto-open reply if in an email thread and compose isn't open yet
        const replyBtn = document.querySelector(
          'div[role="button"][aria-label*="Reply" i], span[role="link"][data-tooltip*="Reply" i], .ams.bkH'
        );
        if (replyBtn) {
          replyBtn.click();
          setTimeout(() => {
            const freshEditor = document.querySelector('div[role="textbox"][contenteditable="true"], div[aria-label*="Message Body"]');
            if (freshEditor) {
              freshEditor.focus();
              document.execCommand('selectAll', false, null);
              const htmlToInsert = text.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
              try {
                document.execCommand('insertHTML', false, htmlToInsert + '<br><br>');
              } catch (_) {}
              if (!freshEditor.innerText.trim()) {
                freshEditor.innerHTML = htmlToInsert + '<br><br>';
              }
              freshEditor.dispatchEvent(new Event('input', { bubbles: true }));
              freshEditor.dispatchEvent(new Event('change', { bubbles: true }));
              showToast('✨ Reply inserted into email box!');
            }
          }, 350);
          return true;
        }
      }
      console.error('[AI Assistant] Could not find compose editor in DOM');
      return false;
    }

    editor.focus();

    if (isChat) {
      // In Google Chat, clean plain text with standard linebreaks
      const cleanText = text.replace(/\r\n/g, '\n').trim();
      document.execCommand('selectAll', false, null);

      let success = false;
      try {
        success = document.execCommand('insertText', false, cleanText);
      } catch (e) {
        console.warn('[AI Assistant] execCommand insertText failed:', e);
      }

      if (!success || !editor.innerText.trim()) {
        editor.innerText = cleanText;
      }

      // Dispatch comprehensive event chain to activate Google Chat's Send button
      try {
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: cleanText, inputType: 'insertText' }));
      } catch (e) {
        // Fallback for older event structure
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));

      // Move cursor to end of text
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    }

    // Gmail Email compose logic
    document.execCommand('selectAll', false, null);

    const htmlToInsert = text.replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');

    let success = false;
    try {
      success = document.execCommand('insertHTML', false, htmlToInsert + '<br><br>');
    } catch (e) {
      console.warn('[AI Assistant] execCommand insertHTML error:', e);
    }

    if (!success || !editor.innerText.trim()) {
      editor.innerHTML = htmlToInsert + '<br><br>';
    }

    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Extracts contact & recent message history from Google Chat
   */
  function extractChatData(toolbar) {
    let sender = '';
    let subject = 'Google Chat Conversation';
    let body = '';

    const chatRoot = toolbar.closest('div[role="main"], div[role="region"], div[data-p], c-wiz, div[aria-label*="Conversation"], div.HH22ic') || toolbar.parentElement || document;

    // 1. Find Sender / Chat Partner Name (filter out date headers like "Today")
    const ignoredWords = [
      'today', 'yesterday', 'history is on', 'history is off',
      'direct messages', 'spaces', 'apps', 'shortcuts', 'chat',
      'unread', 'mentions', 'starred', 'home', 'new chat',
      'active', 'search chat', 'messages sent with history on are saved'
    ];

    // Priority 1: Check for email address in chat top bar or heading
    const allTextNodes = chatRoot.querySelectorAll('span, div, a');
    for (const node of allTextNodes) {
      if (node.closest('div[data-message-id], div[role="listitem"], .gmail-ai-modal-card, div[role="textbox"]')) continue;
      const text = (node.innerText || '').trim();
      if (text.includes('@') && text.includes('.') && text.length > 5 && text.length < 50 && !text.includes(' ') && !text.includes('\n')) {
        sender = text;
        break;
      }
    }

    // Priority 2: Check for header name selectors
    if (!sender) {
      const headerSelectors = [
        '[aria-label*="Conversation with" i]',
        '[aria-label*="Chat with" i]',
        'div[data-name]',
        'span[data-name]',
        'span.Fv9Q0',
        'div.aA0',
        'span.hB'
      ];

      for (const sel of headerSelectors) {
        const headerEl = chatRoot.querySelector(sel) || document.querySelector(sel);
        if (headerEl) {
          let text = (headerEl.getAttribute('aria-label') || headerEl.getAttribute('data-name') || headerEl.innerText || '').trim();
          text = text.replace(/^Conversation with\s*/i, '').replace(/^Chat with\s*/i, '').trim();
          const lower = text.toLowerCase();
          if (text && text.length > 2 && text.length < 50 && !ignoredWords.some(w => lower === w || lower.startsWith(w))) {
            sender = text;
            break;
          }
        }
      }
    }

    // 2. Extract Recent Chat History Messages
    const msgSelectors = [
      'div[data-message-id]',
      'div[role="listitem"]',
      'div.nF6HVc',
      'div.Zc1Eee',
      'div.cZbxYb',
      'div.F9F72c',
      'div[class*="message-content"]',
      'div[class*="messageText"]'
    ];

    let messageElements = chatRoot.querySelectorAll(msgSelectors.join(', '));
    if (messageElements.length === 0) {
      messageElements = document.querySelectorAll(msgSelectors.join(', '));
    }

    const messages = [];
    messageElements.forEach(el => {
      // Don't grab text from the compose box itself
      if (el.closest('div[role="textbox"], .gmail-ai-modal-card')) return;
      const t = (el.innerText || '').trim();
      if (t && t.length > 1 && !messages.includes(t)) {
        messages.push(t);
      }
    });

    if (messages.length > 0) {
      // Keep up to 6 recent messages for context
      const recent = messages.slice(-6);
      body = recent.join('\n---\n');
    }

    return { sender, subject, body, isChat: true };
  }

  /**
   * Extracts text and sender of the email being replied to
   */
  function extractIncomingEmailData(toolbar) {
    let sender = '';
    let subject = '';
    let body = '';

    const threadContainer = toolbar.closest('.nH.hx, .Bk, .gE') || document.querySelector('.nH.hx, .Bk');

    if (threadContainer) {
      const bodies = threadContainer.querySelectorAll('.a3s.aiL, .ii.gt');
      if (bodies.length > 0) {
        body = bodies[bodies.length - 1].innerText || '';
      }

      const senders = threadContainer.querySelectorAll('span[email], .gD, .zF');
      if (senders.length > 0) {
        sender = senders[senders.length - 1].innerText || senders[senders.length - 1].getAttribute('email') || '';
      }
    }

    const subjectEl = document.querySelector('h2.hP');
    if (subjectEl) {
      subject = subjectEl.innerText || '';
    }

    return { sender, subject, body };
  }

  function showToast(message) {
    const existing = document.querySelector('.gmail-ai-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'gmail-ai-toast';
    toast.innerText = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

  function formatProviderError(raw) {
    const msg = String(raw || 'Unknown error');
    const lower = msg.toLowerCase();
    if (lower.includes('api_key_missing') || lower.includes('api key is missing')) {
      return '🔑 API Key missing. Open the extension popup and set your key.';
    }
    if (lower.includes('quota') || lower.includes('exceeded your current quota') || lower.includes('free_tier')) {
      return '📊 Daily free quota exhausted. Switch to OpenAI/Claude in the popup, or wait and retry.';
    }
    if (lower.includes('rate') && lower.includes('limit')) {
      return '🐢 Rate limited. Please wait a moment and try again.';
    }
    if (lower.includes('no longer available') || lower.includes('not found') || lower.includes('not supported')) {
      return '⚙️ Selected model is unavailable. The extension will pick a working one — try again.';
    }
    if (lower.includes('high demand') || lower.includes('overloaded') || lower.includes('503')) {
      return '🔥 AI provider is overloaded. Please retry in a few seconds.';
    }
    if (lower.includes('timed out') || lower.includes('timeout')) {
      return '⏱️ Request timed out. Please try again.';
    }
    if (lower.includes('401') || lower.includes('invalid api key') || lower.includes('incorrect api key')) {
      return '🚫 Invalid API key. Re-check it in the extension popup.';
    }
    return '❌ ' + msg;
  }

  /**
   * Parses AI summary text into structured section cards.
   * Recognises leading emoji markers (📌 🎯 ⏰ 🇧🇩 🇺🇸) and splits accordingly.
   */
  function renderStructuredSummary(text) {
    if (!text) return '';
    const raw = String(text).trim();

    // Section-header pattern: emoji + optional label + ":"
    const sectionRe = /^\s*(📌|🎯|⏰|🇧🇩|🇺🇸)\s*([^:：\n]*)[:：]\s*/;
    const lines = raw.split(/\r?\n/);
    const sections = [];
    let current = null;

    for (const line of lines) {
      const m = line.match(sectionRe);
      if (m) {
        if (current) sections.push(current);
        current = { icon: m[1], label: m[2].trim(), body: line.slice(m[0].length).trim() };
      } else if (current) {
        if (line.trim()) current.body += (current.body ? '\n' : '') + line;
      } else if (line.trim()) {
        current = { icon: '📝', label: '', body: line };
      }
    }
    if (current) sections.push(current);

    if (sections.length === 0) {
      return `<div class="gmail-ai-summary-text">${escapeHtml(raw)}</div>`;
    }

    const renderBody = (body) => {
      // Turn lines starting with -, •, * into a bullet list
      const bodyLines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const bulletLines = bodyLines.filter(l => /^[-•*]\s+/.test(l));
      if (bulletLines.length && bulletLines.length === bodyLines.length) {
        return `<ul class="gmail-ai-sum-list">${
          bodyLines.map(l => `<li>${escapeHtml(l.replace(/^[-•*]\s+/, ''))}</li>`).join('')
        }</ul>`;
      }
      return `<div class="gmail-ai-sum-section-text">${escapeHtml(body)}</div>`;
    };

    return `<div class="gmail-ai-sum-sections">${
      sections.map(s => {
        const isFlag = /🇧🇩|🇺🇸/.test(s.icon);
        if (isFlag) {
          // Flag = sub-group heading (bilingual mode)
          return `<div class="gmail-ai-sum-lang-divider"><span>${s.icon}</span><span>${escapeHtml(s.label || '')}</span></div>${
            s.body ? renderBody(s.body) : ''
          }`;
        }
        return `
          <div class="gmail-ai-sum-section">
            <div class="gmail-ai-sum-section-head">
              <span class="gmail-ai-sum-section-icon">${s.icon}</span>
              <span class="gmail-ai-sum-section-label">${escapeHtml(s.label || '')}</span>
            </div>
            ${renderBody(s.body)}
          </div>
        `;
      }).join('')
    }</div>`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len - 3) + '...' : str;
  }
})();

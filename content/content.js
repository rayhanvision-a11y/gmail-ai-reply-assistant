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

  // Load saved preferences from chrome.storage
  chrome.storage.local.get(['preferredLanguage', 'defaultLength', 'userContext', 'meetingLink'], (res) => {
    if (res && res.preferredLanguage) activeLanguage = res.preferredLanguage;
    if (res && res.defaultLength) activeLength = res.defaultLength;
    if (res && res.userContext) cachedUserContext = res.userContext;
    if (res && res.meetingLink) cachedMeetingLink = res.meetingLink;
  });

  // Keep state live when updated from popup
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.preferredLanguage) activeLanguage = changes.preferredLanguage.newValue;
      if (changes.defaultLength) activeLength = changes.defaultLength.newValue;
      if (changes.userContext) cachedUserContext = changes.userContext.newValue;
      if (changes.meetingLink) cachedMeetingLink = changes.meetingLink.newValue;
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
      const toolbar = btn ? btn.closest('tr.btC, .gU.Up, .aDh') : null;
      if (btn && toolbar) {
        toggleAiModal(toolbar, btn);
      }
    }
  });


  /**
   * Main scan function: scans both Gmail email compose and Google Chat windows
   */
  function checkAndInjectButtons() {
    checkAndInjectEmailButtons();
    checkAndInjectChatButtons();
  }

  /**
   * Scans DOM for Gmail email compose toolbars with universal multi-language support
   */
  function checkAndInjectEmailButtons() {
    const toolbars = document.querySelectorAll('tr.btC, .gU.Up, .aDh');

    toolbars.forEach(toolbar => {
      const sendBtn = toolbar.querySelector(
        '[role="button"][data-tooltip*="Send"], [role="button"][aria-label*="Send"], [role="button"].aoO, [role="button"].T-I-atl, [role="button"][data-tooltip*="Enter"]'
      );
      if (!sendBtn) return;

      if (toolbar.querySelector('.gmail-ai-reply-btn')) return;

      const sendParent = sendBtn.closest('td') || sendBtn.parentElement;
      if (!sendParent) return;
      if (sendParent.querySelector('.gmail-ai-reply-btn')) return;

      const aiBtn = createAiReplyButton(toolbar, false /* isChat = false */);
      sendParent.appendChild(aiBtn);
    });
  }

  /**
   * Scans DOM for Google Chat composer (both inside Gmail and standalone chat.google.com)
   * Strictly targets ONLY the bottom chat input pill and NEVER touches the left navigation rail.
   */
  function checkAndInjectChatButtons() {
    // 0. Safety cleanup: remove any buttons that accidentally land in Gmail's left navigation sidebar
    document.querySelectorAll(
      '.wT .gmail-ai-reply-btn, .aKh .gmail-ai-reply-btn, .aeN .gmail-ai-reply-btn, [role="navigation"] .gmail-ai-reply-btn'
    ).forEach(strayBtn => strayBtn.remove());

    // Strategy 1: Find all potential chat textboxes
    const textboxes = document.querySelectorAll(
      'div[role="textbox"], div[contenteditable], [aria-label*="History is on"], [aria-label*="message" i]'
    );

    textboxes.forEach(textbox => {
      // Must NOT be Gmail email compose editor
      if (textbox.closest('tr.btC, td.gU, .aDh, .M9, form.b7, table.aoP, div[aria-label*="Message Body"]')) {
        return;
      }
      // Must NOT be in Gmail left navigation sidebar
      if (textbox.closest('.wT, .aKh, .aeN, [role="navigation"]')) {
        return;
      }
      // Must NOT be our own modal's textarea or search bar
      if (textbox.closest('.gmail-ai-modal-card') || textbox.getAttribute('aria-label')?.includes('Search') || textbox.getAttribute('name') === 'q') {
        return;
      }

      // Find the surrounding chat composer container
      const composer = textbox.closest('form, div[role="region"], div[role="main"], c-wiz, div[aria-label*="Conversation"], div.HH22ic') || textbox.parentElement?.parentElement?.parentElement;
      if (!composer) return;
      if (composer.querySelector('.gmail-ai-reply-btn')) return;

      // Find action icons (A, emoji, gif, upload, mic) inside this composer
      const actionIcon = composer.querySelector(
        '[aria-label*="voice" i], [aria-label*="audio" i], [aria-label*="mic" i], ' +
        '[data-tooltip*="voice" i], [data-tooltip*="mic" i], ' +
        '[aria-label*="emoji" i], [data-tooltip*="emoji" i], ' +
        '[aria-label*="format" i], [data-tooltip*="format" i], ' +
        '[aria-label*="attach" i], [aria-label*="upload" i]'
      );

      if (actionIcon && actionIcon.parentElement) {
        const iconRow = actionIcon.parentElement;
        if (!iconRow.querySelector('.gmail-ai-reply-btn')) {
          const aiBtn = createAiReplyButton(composer, true /* isChat = true */);
          iconRow.appendChild(aiBtn);
          return;
        }
      }

      // Fallback: look for the Send button in this composer
      const sendBtn = composer.querySelector(
        '[aria-label*="Send message" i], [data-tooltip*="Send message" i], ' +
        '[aria-label*="Send" i]:not([aria-label*="feedback" i]), [data-tooltip*="Send" i]'
      );

      if (sendBtn && sendBtn.parentElement) {
        const sendContainer = sendBtn.parentElement;
        if (!sendContainer.querySelector('.gmail-ai-reply-btn') && !sendContainer.parentElement?.querySelector('.gmail-ai-reply-btn')) {
          const aiBtn = createAiReplyButton(composer, true /* isChat = true */);
          sendContainer.insertBefore(aiBtn, sendBtn);
          return;
        }
      }

      // Fallback: insert beside textbox
      if (textbox.parentElement && !textbox.parentElement.querySelector('.gmail-ai-reply-btn')) {
        const aiBtn = createAiReplyButton(composer, true /* isChat = true */);
        textbox.parentElement.appendChild(aiBtn);
      }
    });

    // Strategy 2: Find Google Chat Send button directly (paper airplane)
    const directSendBtns = document.querySelectorAll(
      'div[role="button"][aria-label*="Send message" i], button[aria-label*="Send message" i], ' +
      'div[role="button"][data-tooltip*="Send message" i], button[data-tooltip*="Send message" i]'
    );

    directSendBtns.forEach(sendBtn => {
      if (sendBtn.closest('tr.btC, td.gU, .aDh, table.aoP, .wT, [role="navigation"]')) return;
      const parent = sendBtn.parentElement;
      if (!parent || parent.querySelector('.gmail-ai-reply-btn') || parent.parentElement?.querySelector('.gmail-ai-reply-btn')) return;

      const chatRoot = sendBtn.closest('form, div[role="region"], div[role="main"], c-wiz, div[aria-label*="Conversation"]') || parent;
      if (chatRoot.querySelector('.gmail-ai-reply-btn')) return;

      const aiBtn = createAiReplyButton(chatRoot, true /* isChat = true */);
      parent.insertBefore(aiBtn, sendBtn);
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

    const card = document.createElement('div');
    card.className = 'gmail-ai-modal-card';

    let activeTab = existingDraftText ? 'polish' : 'generate';
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
          <button type="button" class="gmail-ai-tldr-toggle-btn" id="gmail-ai-tldr-btn" title="${isChat ? 'Summarize conversation history' : 'Summarize incoming email & action items'}">
            <span>⚡</span> TL;DR
          </button>
          <button type="button" class="gmail-ai-modal-close-btn" title="Close (Esc)">&times;</button>
        </div>
      </div>

      <!-- Scrollable Main Content -->
      <div class="gmail-ai-modal-scroll">
        <!-- Feature 1: Summary Box Container (Dynamic) -->
        <div id="gmail-ai-summary-container" style="display: none; margin-bottom: 10px;"></div>

        <!-- Modern Prompt Box -->
        <div class="gmail-ai-prompt-box">
          <textarea 
            class="gmail-ai-textarea" 
            placeholder="${isChat ? 'Type instructions (e.g. tell him I will check and reply in 10 mins)...' : 'Type instructions or notes (e.g. confirm 3 PM call)...'}"
          ></textarea>
        </div>

        <!-- TAB 1: GENERATE NEW REPLY -->
        <div id="tab-generate-panel" style="${activeTab === 'generate' ? 'display: block;' : 'display: none;'}">
          <!-- Quick Smart Replies -->
          <div style="margin-bottom: 12px;">
            <div class="gmail-ai-section-title">
              <span>${isChat ? 'Quick Chat Replies' : 'Quick Smart Replies'}</span>
              <span style="font-weight: normal; text-transform: none; font-size: 10px; color: #94a3b8;">1-click generate</span>
            </div>
            <div class="gmail-ai-chips-wrap">
              ${isChat ? `
                <button type="button" class="gmail-ai-smart-chip" data-intent="Warmly greet, acknowledge, and ask how you can assist">
                  <span>👋</span> Quick Hello
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Acknowledge, agree positively, and confirm sounds great">
                  <span>👍</span> Sounds Good
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Let them know you are actively working on it right now">
                  <span>⚡</span> On It!
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="meeting">
                  <span>📅</span> Propose Call
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Friendly short thank you and appreciation">
                  <span>🙏</span> Thanks!
                </button>
              ` : `
                <button type="button" class="gmail-ai-smart-chip" data-intent="Acknowledge with sincere thanks and confirm receipt">
                  <span>🙏</span> Thanks & Received
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Confirm agreement, accept positively, and outline next steps">
                  <span>👍</span> Confirm & Agree
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="meeting">
                  <span>📅</span> Propose Meeting
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Provide a direct 2-line quick status update">
                  <span>⚡</span> Quick Update
                </button>
                <button type="button" class="gmail-ai-smart-chip" data-intent="Politely and courteously decline with gratitude">
                  <span>❌</span> Polite Decline
                </button>
              `}
            </div>
          </div>

          <!-- Tone & Style Grid -->
          <div>
            <div class="gmail-ai-section-title">Tone & Voice</div>
            <div class="gmail-ai-tones-grid">
              <div class="gmail-ai-tone-card active" data-tone="professional">
                <div class="gmail-ai-tone-card-left">
                  <span class="gmail-ai-tone-icon">👔</span>
                  <span>Professional</span>
                </div>
                <span class="gmail-ai-tone-arrow">→</span>
              </div>

              <div class="gmail-ai-tone-card" data-tone="friendly">
                <div class="gmail-ai-tone-card-left">
                  <span class="gmail-ai-tone-icon">😊</span>
                  <span>Warm & Friendly</span>
                </div>
                <span class="gmail-ai-tone-arrow">→</span>
              </div>

              <div class="gmail-ai-tone-card" data-tone="quick">
                <div class="gmail-ai-tone-card-left">
                  <span class="gmail-ai-tone-icon">⚡</span>
                  <span>Direct (2-3 lines)</span>
                </div>
                <span class="gmail-ai-tone-arrow">→</span>
              </div>

              <div class="gmail-ai-tone-card" data-tone="accept">
                <div class="gmail-ai-tone-card-left">
                  <span class="gmail-ai-tone-icon">🤝</span>
                  <span>Accept & Confirm</span>
                </div>
                <span class="gmail-ai-tone-arrow">→</span>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: POLISH EXISTING DRAFT -->
        <div id="tab-polish-panel" style="${activeTab === 'polish' ? 'display: block;' : 'display: none;'}">
          <div class="gmail-ai-section-title">
            <span>Enhance Active Draft</span>
            <span style="font-weight: normal; text-transform: none; font-size: 10px; color: ${existingDraftText ? '#16a34a' : '#ef4444'};">
              ${existingDraftText ? '✓ Ready to polish' : 'Write text in compose first'}
            </span>
          </div>

          <div class="gmail-ai-polish-list">
            <div class="gmail-ai-polish-card" data-mode="professional">
              <div class="gmail-ai-polish-info">
                <div class="gmail-ai-polish-title"><span>👔</span> Executive & Professional</div>
                <div class="gmail-ai-polish-desc">Elevates draft into polished executive communication</div>
              </div>
              <span class="gmail-ai-tone-arrow">→</span>
            </div>

            <div class="gmail-ai-polish-card" data-mode="grammar">
              <div class="gmail-ai-polish-info">
                <div class="gmail-ai-polish-title"><span>✨</span> Fix Grammar & Clarity</div>
                <div class="gmail-ai-polish-desc">Cleans spelling and syntax while preserving original meaning</div>
              </div>
              <span class="gmail-ai-tone-arrow">→</span>
            </div>

            <div class="gmail-ai-polish-card" data-mode="short">
              <div class="gmail-ai-polish-info">
                <div class="gmail-ai-polish-title"><span>🤏</span> Make Shorter & Direct</div>
                <div class="gmail-ai-polish-desc">Removes fluff, making the email punchy and concise</div>
              </div>
              <span class="gmail-ai-tone-arrow">→</span>
            </div>

            <div class="gmail-ai-polish-card" data-mode="friendly">
              <div class="gmail-ai-polish-info">
                <div class="gmail-ai-polish-title"><span>😊</span> Warm & Courteous</div>
                <div class="gmail-ai-polish-desc">Adds warm, conversational, and polite phrasing</div>
              </div>
              <span class="gmail-ai-tone-arrow">→</span>
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
    const toneCards = card.querySelectorAll('.gmail-ai-tone-card');

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

    // Feature 1: TL;DR Summary 1-Click
    const tldrBtn = card.querySelector('#gmail-ai-tldr-btn');
    const summaryContainer = card.querySelector('#gmail-ai-summary-container');
    if (tldrBtn && summaryContainer) {
      tldrBtn.addEventListener('click', () => {
        if (!emailData.body || emailData.body.trim().length < 10) {
          showToast('⚠️ No incoming email message detected to summarize.');
          return;
        }

        summaryContainer.style.display = 'block';
        summaryContainer.innerHTML = `
          <div class="gmail-ai-summary-box">
            <div class="gmail-ai-summary-header">
              <span>⚡ Generating Summary & Actions...</span>
              <button type="button" class="gmail-ai-summary-close" title="Close">&times;</button>
            </div>
            <div style="font-size: 11.5px; color: #64748b; font-style: italic;">
              Analyzing incoming email with AI...
            </div>
          </div>
        `;

        const closeBtn = summaryContainer.querySelector('.gmail-ai-summary-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', () => {
            summaryContainer.style.display = 'none';
            summaryContainer.innerHTML = '';
          });
        }

        safeSendMessage({
          action: 'SUMMARIZE_EMAIL',
          data: emailData
        }, (response) => {
          if (!response) return;
          if (response.success && response.summary) {
            summaryContainer.innerHTML = `
              <div class="gmail-ai-summary-box">
                <div class="gmail-ai-summary-header">
                  <span>⚡ Summary & Action Items</span>
                  <button type="button" class="gmail-ai-summary-close" title="Close">&times;</button>
                </div>
                <div style="font-size: 11.5px; color: #1e293b; line-height: 1.45; white-space: pre-wrap;">${escapeHtml(response.summary)}</div>
              </div>
            `;
            const dynClose = summaryContainer.querySelector('.gmail-ai-summary-close');
            if (dynClose) {
              dynClose.addEventListener('click', () => {
                summaryContainer.style.display = 'none';
                summaryContainer.innerHTML = '';
              });
            }
          } else {
            summaryContainer.style.display = 'none';
            showToast(formatProviderError(response.error || 'Failed to summarize email.'));
          }
        });
      });
    }

    // Smart Chip 1-Click Generation
    card.querySelectorAll('.gmail-ai-smart-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const intent = chip.getAttribute('data-intent');
        triggerReplyGeneration(card, toolbar, emailData, selectedTone, intent);
      });
    });

    // Tone Card Selection & Generation
    toneCards.forEach(tc => {
      tc.addEventListener('click', () => {
        toneCards.forEach(c => c.classList.remove('active'));
        tc.classList.add('active');
        selectedTone = tc.getAttribute('data-tone');
        triggerReplyGeneration(card, toolbar, emailData, selectedTone, '');
      });
    });

    // Polish Card 1-Click Polish
    card.querySelectorAll('.gmail-ai-polish-card').forEach(item => {
      item.addEventListener('click', () => {
        const mode = item.getAttribute('data-mode');
        triggerPolishDraft(card, toolbar, mode, '', isChat);
      });
    });

    // Generate / Submit Button
    submitBtn.addEventListener('click', () => {
      const customNotes = textarea.value.trim();
      if (activeTab === 'generate') {
        triggerReplyGeneration(card, toolbar, emailData, selectedTone, customNotes);
      } else {
        triggerPolishDraft(card, toolbar, isChat ? 'friendly' : 'professional', customNotes, isChat);
      }
    });

    // Keyboard Shortcuts: Enter (with Ctrl/Cmd or plain Enter in empty text)
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
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
    if (intentNote === 'meeting') {
      computedIntent = cachedMeetingLink
        ? `Propose scheduling a meeting/call and include booking link directly: ${cachedMeetingLink}`
        : 'Propose scheduling a 20-30 minute meeting call next week and ask for their availability.';
    }

    const fullNotes = [computedIntent, customNotes].filter(Boolean).join(' | ');

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
    const editor = findComposeEditor(toolbar, isChat);
    if (!editor) {
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

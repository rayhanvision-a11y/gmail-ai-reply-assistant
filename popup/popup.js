/**
 * Multi-Provider Settings Controller for Gmail AI Reply Assistant
 */

document.addEventListener('DOMContentLoaded', async () => {
  const providerTabs = document.querySelectorAll('.tab-btn');
  const keyLabel = document.getElementById('key-label');
  const apiKeyInput = document.getElementById('api-key');
  const keyHelp = document.getElementById('key-help');
  const modelGroup = document.getElementById('model-group');
  const modelSelect = document.getElementById('model-select');
  const lengthPills = document.querySelectorAll('#length-pill-group .pill-btn');
  const userSignOffInput = document.getElementById('user-signoff');
  const toggleVisibilityBtn = document.getElementById('toggle-key-visibility');
  const testBtn = document.getElementById('test-btn');
  const saveBtn = document.getElementById('save-btn');
  const statusBadge = document.getElementById('status-badge');
  const statusMsg = document.getElementById('status-message');

  const providerConfigs = {
    gemini: {
      name: 'Google Gemini',
      keyField: 'geminiApiKey',
      label: 'Gemini API Key',
      placeholder: 'Paste AIzaSy... key',
      help: 'Get free key from <a href="https://aistudio.google.com/app/apikey" target="_blank">Google AI Studio</a>.',
      models: null
    },
    openai: {
      name: 'OpenAI (ChatGPT)',
      keyField: 'openaiApiKey',
      label: 'OpenAI API Key',
      placeholder: 'Paste sk-proj-... key',
      help: 'Get key from <a href="https://platform.openai.com/api-keys" target="_blank">OpenAI Platform</a>.',
      models: [
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Fast & Cheap)' },
        { id: 'gpt-4o', name: 'GPT-4o (Most Intelligent)' }
      ]
    },
    claude: {
      name: 'Anthropic (Claude)',
      keyField: 'claudeApiKey',
      label: 'Claude API Key',
      placeholder: 'Paste sk-ant-... key',
      help: 'Get key from <a href="https://console.anthropic.com/settings/keys" target="_blank">Anthropic Console</a>.',
      models: [
        { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku (Ultra Fast)' },
        { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet (Elite Writing)' }
      ]
    },
    openrouter: {
      name: 'OpenRouter',
      keyField: 'openrouterApiKey',
      label: 'OpenRouter API Key',
      placeholder: 'Paste sk-or-v1-... key',
      help: 'Get key from <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>. Many <b>:free</b> models — no charge.',
      models: [
        { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free, GPT-4o-like)' },
        { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 (Free, powerful)' },
        { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)' },
        { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen 2.5 72B (Free)' },
        { id: 'mistralai/mistral-small-3.1-24b-instruct:free', name: 'Mistral Small 3.1 (Free)' },
        { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku (Paid)' },
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (Paid)' }
      ]
    },
    chrome: {
      name: 'Chrome Built-in AI',
      keyField: null,
      noKey: true,
      models: null
    }
  };

  const apikeyGroup = document.getElementById('apikey-group');
  const chromeAiPanel = document.getElementById('chrome-ai-panel');
  const chromeAiStatus = document.getElementById('chrome-ai-status');
  const openChromeFlag = document.getElementById('open-chrome-flag');
  if (openChromeFlag) {
    openChromeFlag.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://flags/#prompt-api-for-gemini-nano' });
    });
  }

  const langSelect = document.getElementById('default-language');
  const userContextInput = document.getElementById('user-context');
  const meetingLinkInput = document.getElementById('meeting-link');

  // Load existing configuration
  const storage = await chrome.storage.local.get([
    'aiProvider',
    'geminiApiKey',
    'openaiApiKey',
    'claudeApiKey',
    'openrouterApiKey',
    'openaiModel',
    'claudeModel',
    'openrouterModel',
    'defaultLength',
    'preferredLanguage',
    'userContext',
    'meetingLink',
    'userSignOff'
  ]);

  let currentProvider = storage.aiProvider || 'gemini';
  let currentLength = storage.defaultLength || 'medium';

  // Set preferred language
  if (langSelect && storage.preferredLanguage) {
    langSelect.value = storage.preferredLanguage;
  }
  if (langSelect) {
    langSelect.addEventListener('change', () => {
      chrome.storage.local.set({ preferredLanguage: langSelect.value });
    });
  }

  // Set user role & company context
  if (userContextInput && storage.userContext) {
    userContextInput.value = storage.userContext;
  }

  // Set meeting link
  if (meetingLinkInput && storage.meetingLink) {
    meetingLinkInput.value = storage.meetingLink;
  }

  // Set sign-off
  if (storage.userSignOff) {
    userSignOffInput.value = storage.userSignOff;
  }

  // Set length pills
  lengthPills.forEach(pill => {
    pill.classList.toggle('active', pill.dataset.length === currentLength);
    pill.addEventListener('click', () => {
      lengthPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      currentLength = pill.dataset.length;
    });
  });

  const keySecurityBadge = document.getElementById('key-security-badge');
  const clearKeyBtn = document.getElementById('clear-key-btn');

  function maskSecretKey(key) {
    if (!key) return '';
    const trimmed = key.trim();
    if (trimmed.length <= 10) return '••••••••••••••••';
    const prefix = trimmed.substring(0, 6);
    const suffix = trimmed.substring(trimmed.length - 4);
    return `${prefix}••••••••••••••••${suffix}`;
  }

  // Switch Provider
  function switchProvider(provider) {
    currentProvider = provider;
    providerTabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.provider === provider);
    });

    const cfg = providerConfigs[provider];

    if (cfg.noKey) {
      // Chrome Built-in AI — hide key input, show info panel
      apikeyGroup.style.display = 'none';
      chromeAiPanel.style.display = 'block';
      modelGroup.style.display = 'none';
      chromeAiStatus.textContent = 'Checking…';
      checkChromeAiStatus();
      return;
    }

    apikeyGroup.style.display = 'block';
    chromeAiPanel.style.display = 'none';

    keyLabel.textContent = cfg.label;
    apiKeyInput.placeholder = cfg.placeholder;
    keyHelp.innerHTML = cfg.help;

    const keyVal = storage[cfg.keyField] || '';

    if (keyVal) {
      // STEALTH MASK: Never expose the full raw secret key in the DOM
      apiKeyInput.value = maskSecretKey(keyVal);
      apiKeyInput.setAttribute('data-is-masked', 'true');
      apiKeyInput.setAttribute('readonly', 'true');
      apiKeyInput.type = 'text';

      if (clearKeyBtn) clearKeyBtn.style.display = 'inline-block';
      if (toggleVisibilityBtn) toggleVisibilityBtn.style.display = 'none';
      if (keySecurityBadge) keySecurityBadge.style.display = 'inline-flex';

      statusBadge.textContent = 'Ready (Protected)';
      statusBadge.className = 'status-badge active';
    } else {
      apiKeyInput.value = '';
      apiKeyInput.removeAttribute('data-is-masked');
      apiKeyInput.removeAttribute('readonly');
      apiKeyInput.type = 'password';

      if (clearKeyBtn) clearKeyBtn.style.display = 'none';
      if (toggleVisibilityBtn) {
        toggleVisibilityBtn.style.display = 'inline-block';
        toggleVisibilityBtn.textContent = '👁️';
      }
      if (keySecurityBadge) keySecurityBadge.style.display = 'none';

      statusBadge.textContent = 'Key Missing';
      statusBadge.className = 'status-badge missing';
    }

    if (cfg.models) {
      modelGroup.style.display = 'flex';
      modelSelect.innerHTML = cfg.models.map(m =>
        `<option value="${m.id}">${m.name}</option>`
      ).join('');

      const savedModel =
        provider === 'openai' ? storage.openaiModel :
        provider === 'claude' ? storage.claudeModel :
        provider === 'openrouter' ? storage.openrouterModel : null;
      if (savedModel) modelSelect.value = savedModel;
    } else {
      modelGroup.style.display = 'none';
    }
  }

  function checkChromeAiStatus() {
    chrome.runtime.sendMessage({
      action: 'VALIDATE_API_KEY',
      provider: 'chrome',
      apiKey: ''
    }, (response) => {
      void chrome.runtime.lastError;
      if (response && response.success) {
        chromeAiStatus.textContent = '✅ Available on this device';
        chromeAiStatus.style.color = '#188038';
        statusBadge.textContent = 'Ready';
        statusBadge.className = 'status-badge active';
      } else {
        chromeAiStatus.textContent = '⚠️ ' + (response?.error || 'Unavailable');
        chromeAiStatus.style.color = '#d93025';
        statusBadge.textContent = 'Not available';
        statusBadge.className = 'status-badge missing';
      }
    });
  }

  providerTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      switchProvider(tab.dataset.provider);
    });
  });

  // Initial render
  switchProvider(currentProvider);

  // Toggle key visibility (Only active when typing a new key)
  toggleVisibilityBtn.addEventListener('click', () => {
    if (apiKeyInput.getAttribute('data-is-masked') === 'true') {
      showMsg('🔒 Full key is hidden for stealth protection. Click ✏️ to replace it.', 'info');
      return;
    }
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleVisibilityBtn.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleVisibilityBtn.textContent = '👁️';
    }
  });

  // Change / Replace Key Button
  if (clearKeyBtn) {
    clearKeyBtn.addEventListener('click', () => {
      const cfg = providerConfigs[currentProvider];
      apiKeyInput.removeAttribute('readonly');
      apiKeyInput.removeAttribute('data-is-masked');
      apiKeyInput.value = '';
      apiKeyInput.type = 'password';
      apiKeyInput.placeholder = `Paste new ${cfg.name} key...`;
      apiKeyInput.focus();

      clearKeyBtn.style.display = 'none';
      toggleVisibilityBtn.style.display = 'inline-block';
      toggleVisibilityBtn.textContent = '👁️';
      if (keySecurityBadge) keySecurityBadge.style.display = 'none';

      showMsg(`✏️ Enter your new ${cfg.name} key and click "Save Settings"`, 'info');
    });
  }

  // Save Settings
  saveBtn.addEventListener('click', async () => {
    const isMasked = apiKeyInput.getAttribute('data-is-masked') === 'true';
    const enteredKey = apiKeyInput.value.trim();
    const signOff = userSignOffInput.value.trim();
    const cfg = providerConfigs[currentProvider];
    let keyToSave = null;

    if (!cfg.noKey) {
      if (isMasked) {
        keyToSave = storage[cfg.keyField];
        if (!keyToSave) {
          showMsg(`Please enter a valid ${cfg.name} Key`, 'error');
          return;
        }
      } else {
        if (!enteredKey) {
          showMsg(`Please enter a valid ${cfg.name} Key`, 'error');
          return;
        }
        keyToSave = enteredKey;
      }
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const updates = {
      aiProvider: currentProvider,
      defaultLength: currentLength,
      userSignOff: signOff
    };

    if (langSelect) updates.preferredLanguage = langSelect.value;
    if (userContextInput) updates.userContext = userContextInput.value.trim();
    if (meetingLinkInput) updates.meetingLink = meetingLinkInput.value.trim();
    if (cfg.keyField && keyToSave) updates[cfg.keyField] = keyToSave;
    if (currentProvider === 'openai') updates.openaiModel = modelSelect.value;
    if (currentProvider === 'claude') updates.claudeModel = modelSelect.value;
    if (currentProvider === 'openrouter') updates.openrouterModel = modelSelect.value;

    await chrome.storage.local.set(updates);

    // Update in-memory storage ref
    Object.assign(storage, updates);

    // Immediately re-apply stealth masking to protect the newly saved key
    if (!cfg.noKey && keyToSave) {
      apiKeyInput.value = maskSecretKey(keyToSave);
      apiKeyInput.setAttribute('data-is-masked', 'true');
      apiKeyInput.setAttribute('readonly', 'true');
      apiKeyInput.type = 'text';

      if (clearKeyBtn) clearKeyBtn.style.display = 'inline-block';
      if (toggleVisibilityBtn) toggleVisibilityBtn.style.display = 'none';
      if (keySecurityBadge) keySecurityBadge.style.display = 'inline-flex';
    }

    statusBadge.textContent = 'Ready (Protected)';
    statusBadge.className = 'status-badge active';

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Settings';
    showMsg(`🔒 ${cfg.name} settings saved & stealth protected!`, 'success');
  });

  // Test Key
  testBtn.addEventListener('click', () => {
    const isMasked = apiKeyInput.getAttribute('data-is-masked') === 'true';
    const cfg = providerConfigs[currentProvider];
    const keyToTest = isMasked ? (storage[cfg.keyField] || '') : apiKeyInput.value.trim();

    if (!cfg.noKey && !keyToTest) {
      showMsg(`Please enter a ${cfg.name} key to test`, 'error');
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';

    chrome.runtime.sendMessage({
      action: 'VALIDATE_API_KEY',
      provider: currentProvider,
      apiKey: cfg.noKey ? '' : keyToTest
    }, (response) => {
      testBtn.disabled = false;
      testBtn.textContent = '⚡ Test Key';

      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        showMsg(`❌ Service worker unreachable: ${lastErr.message}. Reload the extension.`, 'error');
        return;
      }
      if (!response) {
        showMsg('❌ No response from background. Try again.', 'error');
        return;
      }
      if (response.success) {
        showMsg(`🎉 Connected to ${cfg.name}! (${response.model || 'Active'})`, 'success');
      } else {
        showMsg(`❌ Error: ${response.error || 'Validation failed'}`, 'error');
      }
    });
  });

  function showMsg(text, type) {
    statusMsg.textContent = text;
    statusMsg.className = `status-message ${type}`;
    statusMsg.style.display = 'block';

    setTimeout(() => {
      statusMsg.style.display = 'none';
    }, 4500);
  }

  // ========================================================
  // GitHub Live Sync & Update Controller
  // ========================================================
  const currentManifestVer = (chrome.runtime && chrome.runtime.getManifest) 
    ? chrome.runtime.getManifest().version 
    : '1.0.0';

  const versionTag = document.getElementById('current-version-tag');
  const syncBtn = document.getElementById('sync-update-btn');
  const syncBtnLabel = document.getElementById('sync-btn-label');
  const syncStatusTitle = document.getElementById('sync-status-title');
  const syncStatusDesc = document.getElementById('sync-status-desc');
  const updateActionBox = document.getElementById('update-action-box');

  if (versionTag) {
    versionTag.textContent = `v${currentManifestVer}`;
  }

  function compareSemver(remote, local) {
    const r = (remote || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const l = (local || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rNum = r[i] || 0;
      const lNum = l[i] || 0;
      if (rNum > lNum) return 1;
      if (rNum < lNum) return -1;
    }
    return 0;
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.classList.add('loading');
      syncBtnLabel.textContent = 'Checking...';
      syncStatusTitle.textContent = 'Contacting GitHub...';
      syncStatusDesc.textContent = 'Checking repository releases and updates.';
      updateActionBox.style.display = 'none';

      // Ask chrome to check for extensions update if supported
      if (chrome.runtime && chrome.runtime.requestUpdateCheck) {
        try { chrome.runtime.requestUpdateCheck(() => {}); } catch (_) {}
      }

      const REPO_OWNER = 'rayhanvision-a11y';
      const REPO_NAME = 'gmail-ai-reply-assistant';
      const GITHUB_API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
      const RAW_MANIFEST_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/manifest.json`;

      try {
        let latestVersion = null;
        let releaseName = '';
        let downloadUrl = `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/main.zip`;

        // 1. Try fetching latest release from GitHub API
        try {
          const apiRes = await fetch(GITHUB_API_URL, {
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            cache: 'no-store'
          });
          if (apiRes.ok) {
            const release = await apiRes.json();
            latestVersion = (release.tag_name || '').replace(/^v/, '');
            releaseName = release.name || release.tag_name || '';
            const zipAsset = (release.assets || []).find(a => a.name.endsWith('.zip'));
            if (zipAsset && zipAsset.browser_download_url) {
              downloadUrl = zipAsset.browser_download_url;
            } else if (release.zipball_url) {
              downloadUrl = release.zipball_url;
            }
          }
        } catch (apiErr) {
          console.warn('[Sync] GitHub API check failed, fallback to raw manifest:', apiErr);
        }

        // 2. Fallback to raw manifest if no release found or rate-limited
        if (!latestVersion) {
          const rawRes = await fetch(RAW_MANIFEST_URL, { cache: 'no-store' });
          if (rawRes.ok) {
            const rawManifest = await rawRes.json();
            latestVersion = rawManifest.version;
            releaseName = `v${latestVersion}`;
          }
        }

        if (!latestVersion) {
          throw new Error('Unable to connect to GitHub. Please check internet connection.');
        }

        const cmp = compareSemver(latestVersion, currentManifestVer);

        if (cmp > 0) {
          // New version is available!
          syncStatusTitle.textContent = `🎉 New Update: v${latestVersion}`;
          syncStatusDesc.textContent = `A newer version is available on GitHub!`;
          updateActionBox.className = 'update-action-box available';
          updateActionBox.innerHTML = `
            <div><strong>Update v${latestVersion} Available</strong> (${releaseName || 'Latest Release'})</div>
            <div style="margin-top: 4px; font-size: 10.5px; color: #713f12;">
              Download the zip or pull changes, then click Reload.
            </div>
            <div class="update-action-btn-row">
              <a href="${downloadUrl}" target="_blank" class="update-action-btn primary" id="action-download-btn">⬇️ Download ZIP</a>
              <button type="button" class="update-action-btn secondary" id="action-reload-btn">🔄 Reload Extension</button>
            </div>
          `;
          updateActionBox.style.display = 'block';

          // Bind reload button
          document.getElementById('action-reload-btn')?.addEventListener('click', () => {
            if (chrome.runtime && chrome.runtime.reload) {
              chrome.runtime.reload();
            } else {
              window.location.reload();
            }
          });
        } else {
          // Extension is already up to date!
          syncStatusTitle.textContent = `✅ Extension Up to Date`;
          syncStatusDesc.textContent = `Running v${currentManifestVer}. Cloud connection verified.`;
          updateActionBox.className = 'update-action-box uptodate';
          updateActionBox.innerHTML = `
            <div>✨ You are running the latest version (<b>v${currentManifestVer}</b>).</div>
            <div class="update-action-btn-row">
              <button type="button" class="update-action-btn secondary" id="action-reload-btn">🔄 Quick Reload Extension</button>
            </div>
          `;
          updateActionBox.style.display = 'block';

          document.getElementById('action-reload-btn')?.addEventListener('click', () => {
            if (chrome.runtime && chrome.runtime.reload) {
              chrome.runtime.reload();
            } else {
              window.location.reload();
            }
          });
        }

        // Save last synced timestamp
        chrome.storage.local.set({ lastGitHubSync: Date.now() });

      } catch (err) {
        console.error('[Sync Error]', err);
        syncStatusTitle.textContent = '❌ Sync Failed';
        syncStatusDesc.textContent = err.message || 'Error connecting to GitHub.';
        updateActionBox.className = 'update-action-box error';
        updateActionBox.innerHTML = `
          <div>${err.message || 'Could not reach GitHub.'}</div>
          <div class="update-action-btn-row">
            <button type="button" class="update-action-btn secondary" id="action-reload-btn">🔄 Reload Extension</button>
          </div>
        `;
        updateActionBox.style.display = 'block';

        document.getElementById('action-reload-btn')?.addEventListener('click', () => {
          if (chrome.runtime && chrome.runtime.reload) chrome.runtime.reload();
        });
      } finally {
        syncBtn.classList.remove('loading');
        syncBtnLabel.textContent = 'Sync Now';
      }
    });
  }
});


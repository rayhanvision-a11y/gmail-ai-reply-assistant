/**
 * UI Builder for Gmail Add-on using Google Workspace CardService.
 * Recreates the clean native modal design seen in Gmail Compose Actions.
 */

/**
 * Builds the main Reply Assistant card shown when the user clicks the toolbar icon
 * @param {Object} context - Email thread context (sender, subject, messageId)
 * @return {CardService.Card}
 */
function buildMainReplyCard(context) {
  var apiKey = getApiKey();
  if (!apiKey) {
    return buildApiKeySettingsCard(context, 'Please set your Gemini API Key to start generating AI replies.');
  }

  var card = CardService.newCardBuilder();

  // Header matching the reference card design
  card.setHeader(
    CardService.newCardHeader()
      .setTitle('AI Reply Assistant')
      .setSubtitle(context.sender ? 'Replying to: ' + truncateText(context.sender, 32) : 'Generate smart email reply')
      .setImageStyle(CardService.ImageStyle.SQUARE)
      .setImageUrl('https://cdn-icons-png.flaticon.com/512/8649/8649595.png')
  );

  // Section 1: Quick One-Click Reply Actions (Card list style like reference image)
  var quickSection = CardService.newCardSection()
    .setHeader('<b>SELECT REPLY TONE</b>');

  var tones = [
    {
      id: 'professional',
      title: '👔 Professional & Formal',
      subtitle: 'Clear, polite, and executive business tone',
      color: '#1a73e8'
    },
    {
      id: 'friendly',
      title: '😊 Warm & Friendly',
      subtitle: 'Approachable, warm, and conversational',
      color: '#0d904f'
    },
    {
      id: 'quick',
      title: '⚡ Quick & Direct',
      subtitle: 'Short 2-3 sentences straight to the point',
      color: '#ea8600'
    },
    {
      id: 'accept',
      title: '👍 Accept / Agree',
      subtitle: 'Accept invitation, offer, or confirm attendance',
      color: '#188038'
    },
    {
      id: 'decline',
      title: '❌ Polite Decline',
      subtitle: 'Respectfully decline with courtesy and thanks',
      color: '#d93025'
    }
  ];

  for (var i = 0; i < tones.length; i++) {
    var t = tones[i];
    var action = CardService.newAction()
      .setFunctionName('handleGenerateReplyAction')
      .setParameters({
        messageId: context.messageId || '',
        subject: context.subject || '',
        sender: context.sender || '',
        tone: t.id
      });

    quickSection.addWidget(
      CardService.newDecoratedText()
        .setTopLabel('Quick Tone')
        .setText(t.title)
        .setBottomLabel(t.subtitle)
        .setOnClickAction(action)
    );
  }

  card.addSection(quickSection);

  // Section 2: Custom Instructions & Language (Advanced)
  var customSection = CardService.newCardSection()
    .setHeader('<b>CUSTOM INSTRUCTION (OPTIONAL)</b>');

  customSection.addWidget(
    CardService.newTextInput()
      .setFieldName('custom_notes')
      .setTitle('Add specific details or instructions')
      .setHint('e.g., Tell them I am free on Thursday after 3 PM')
      .setMultiline(true)
  );

  var langDropdown = CardService.newSelectionInput()
    .setType(CardService.SelectionInputType.DROPDOWN)
    .setTitle('Output Language')
    .setFieldName('output_language')
    .addItem('Auto Detect (Same as incoming)', 'auto', true)
    .addItem('English', 'en', false)
    .addItem('Bengali (বাংলা)', 'bn', false);

  customSection.addWidget(langDropdown);

  var customAction = CardService.newAction()
    .setFunctionName('handleGenerateCustomReplyAction')
    .setParameters({
      messageId: context.messageId || '',
      subject: context.subject || '',
      sender: context.sender || ''
    });

  var customButton = CardService.newTextButton()
    .setText('✨ Generate With Custom Note')
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor('#1a73e8')
    .setOnClickAction(customAction);

  customSection.addWidget(
    CardService.newButtonSet().addButton(customButton)
  );

  card.addSection(customSection);

  // Section 3: Footer settings link
  var footerSection = CardService.newCardSection();
  var settingsAction = CardService.newAction()
    .setFunctionName('openSettingsCard')
    .setParameters({
      messageId: context.messageId || '',
      subject: context.subject || '',
      sender: context.sender || ''
    });

  footerSection.addWidget(
    CardService.newDecoratedText()
      .setText('⚙️ Settings & API Key')
      .setBottomLabel('Change API key, default sign-off')
      .setOnClickAction(settingsAction)
  );

  card.addSection(footerSection);

  return card.build();
}

/**
 * Builds the Settings card for configuring Gemini API Key & Preferences
 */
function buildApiKeySettingsCard(context, noticeMsg) {
  var currentKey = getApiKey();
  var currentSignOff = getUserSignOff();

  var card = CardService.newCardBuilder();
  card.setHeader(
    CardService.newCardHeader()
      .setTitle('Add-on Settings')
      .setSubtitle('Configure your Gemini AI connection')
      .setImageUrl('https://cdn-icons-png.flaticon.com/512/8649/8649595.png')
  );

  var section = CardService.newCardSection();

  if (noticeMsg) {
    section.addWidget(
      CardService.newTextParagraph()
        .setText('<font color="#d93025"><b>' + noticeMsg + '</b></font>')
    );
  }

  section.addWidget(
    CardService.newTextParagraph()
      .setText('Gemini API is free to use. Get your free key from <a href="https://aistudio.google.com/app/apikey">Google AI Studio</a>.')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('api_key_input')
      .setTitle('Gemini API Key')
      .setValue(currentKey ? '••••••••' + currentKey.slice(-4) : '')
      .setHint('Paste AIzaSy... key here')
  );

  section.addWidget(
    CardService.newTextInput()
      .setFieldName('user_signoff_input')
      .setTitle('Custom Sign-off (Optional)')
      .setValue(currentSignOff)
      .setHint('e.g., Best regards, VisionTech Team')
  );

  var saveAction = CardService.newAction()
    .setFunctionName('handleSaveSettings')
    .setParameters({
      messageId: (context && context.messageId) ? context.messageId : '',
      subject: (context && context.subject) ? context.subject : '',
      sender: (context && context.sender) ? context.sender : ''
    });

  var saveBtn = CardService.newTextButton()
    .setText('Save & Continue')
    .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
    .setBackgroundColor('#1a73e8')
    .setOnClickAction(saveAction);

  section.addWidget(
    CardService.newButtonSet().addButton(saveBtn)
  );

  card.addSection(section);
  return card.build();
}

/**
 * Helper to truncate long strings for cleaner UI
 */
function truncateText(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

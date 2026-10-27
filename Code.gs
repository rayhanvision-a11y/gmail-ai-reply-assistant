/**
 * AI Reply Assistant - Main Controller
 * Entry point for Gmail Compose Action and Event Handlers
 */

/**
 * Triggered when the user clicks the AI Reply icon in the Gmail Compose toolbar
 * @param {Object} e - Event object from Gmail
 * @return {CardService.Card}
 */
function onGmailCompose(e) {
  var context = extractEmailContext(e);
  return buildMainReplyCard(context);
}

/**
 * Extracts context (messageId, sender, subject, body) from the incoming email being replied to
 * @param {Object} e - Event object
 * @return {Object}
 */
function extractEmailContext(e) {
  var context = {
    messageId: '',
    sender: '',
    subject: '',
    body: ''
  };

  try {
    if (e && e.gmail) {
      if (e.gmail.messageId) {
        context.messageId = e.gmail.messageId;
        var message = GmailApp.getMessageById(context.messageId);
        if (message) {
          context.sender = message.getFrom();
          context.subject = message.getSubject();
          context.body = message.getPlainBody() || message.getBody();
        }
      }
    }
  } catch (err) {
    Logger.log('Context extraction error: ' + err.toString());
  }

  return context;
}

/**
 * Handles Quick Tone button clicks
 * Generates the reply and directly inserts it into the active Gmail draft
 * @param {Object} e - Event object
 * @return {CardService.UpdateDraftActionResponse|CardService.ActionResponse}
 */
function handleGenerateReplyAction(e) {
  var params = (e && e.parameters) ? e.parameters : {};
  var tone = params.tone || 'professional';
  var messageId = params.messageId || '';
  var subject = params.subject || '';
  var sender = params.sender || '';

  // Get email body
  var emailBody = '';
  if (messageId) {
    try {
      var msg = GmailApp.getMessageById(messageId);
      if (msg) {
        emailBody = msg.getPlainBody() || msg.getBody();
        if (!sender) sender = msg.getFrom();
        if (!subject) subject = msg.getSubject();
      }
    } catch (err) {
      Logger.log('Error fetching message: ' + err.toString());
    }
  }

  try {
    var replyHtml = generateEmailReply({
      emailBody: emailBody,
      sender: sender,
      subject: subject,
      tone: tone,
      customNote: '',
      language: 'auto'
    });

    // Insert the generated text directly into the Gmail compose body
    var updateDraftBodyAction = CardService.newUpdateDraftBodyAction()
      .addUpdateContent(replyHtml, CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT);

    return CardService.newUpdateDraftActionResponseBuilder()
      .setUpdateDraftBodyAction(updateDraftBodyAction)
      .build();

  } catch (error) {
    if (error.message === 'API_KEY_MISSING') {
      return CardService.newActionResponseBuilder()
        .setNavigation(
          CardService.newNavigation().pushCard(
            buildApiKeySettingsCard({ messageId: messageId, subject: subject, sender: sender }, 'Please enter your Gemini API Key first.')
          )
        )
        .build();
    }

    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification().setText('⚠️ ' + error.message)
      )
      .build();
  }
}

/**
 * Handles Generate button click with Custom Note and Language
 * @param {Object} e - Event object
 * @return {CardService.UpdateDraftActionResponse|CardService.ActionResponse}
 */
function handleGenerateCustomReplyAction(e) {
  var params = (e && e.parameters) ? e.parameters : {};
  var formInputs = (e && e.formInput) ? e.formInput : {};
  
  var customNotes = formInputs.custom_notes || '';
  var language = formInputs.output_language || 'auto';
  var messageId = params.messageId || '';
  var subject = params.subject || '';
  var sender = params.sender || '';

  var emailBody = '';
  if (messageId) {
    try {
      var msg = GmailApp.getMessageById(messageId);
      if (msg) {
        emailBody = msg.getPlainBody() || msg.getBody();
        if (!sender) sender = msg.getFrom();
        if (!subject) subject = msg.getSubject();
      }
    } catch (err) {
      Logger.log('Error fetching message: ' + err.toString());
    }
  }

  try {
    var replyHtml = generateEmailReply({
      emailBody: emailBody,
      sender: sender,
      subject: subject,
      tone: 'professional',
      customNote: customNotes,
      language: language
    });

    var updateDraftBodyAction = CardService.newUpdateDraftBodyAction()
      .addUpdateContent(replyHtml, CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT);

    return CardService.newUpdateDraftActionResponseBuilder()
      .setUpdateDraftBodyAction(updateDraftBodyAction)
      .build();

  } catch (error) {
    if (error.message === 'API_KEY_MISSING') {
      return CardService.newActionResponseBuilder()
        .setNavigation(
          CardService.newNavigation().pushCard(
            buildApiKeySettingsCard({ messageId: messageId, subject: subject, sender: sender }, 'Please enter your Gemini API Key first.')
          )
        )
        .build();
    }

    return CardService.newActionResponseBuilder()
      .setNotification(
        CardService.newNotification().setText('⚠️ ' + error.message)
      )
      .build();
  }
}

/**
 * Opens Settings Card
 */
function openSettingsCard(e) {
  var params = (e && e.parameters) ? e.parameters : {};
  var card = buildApiKeySettingsCard(params);
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(card))
    .build();
}

/**
 * Saves Settings (API Key & Sign-off)
 */
function handleSaveSettings(e) {
  var formInputs = (e && e.formInput) ? e.formInput : {};
  var params = (e && e.parameters) ? e.parameters : {};

  var newApiKey = formInputs.api_key_input || '';
  var newSignOff = formInputs.user_signoff_input || '';

  // Only update if not the masked placeholder
  if (newApiKey && newApiKey.indexOf('••••••••') === -1) {
    saveApiKey(newApiKey);
  }

  setUserSignOff(newSignOff);

  var updatedCard = buildMainReplyCard(params);

  return CardService.newActionResponseBuilder()
    .setNotification(
      CardService.newNotification().setText('✅ Settings saved successfully!')
    )
    .setNavigation(
      CardService.newNavigation().updateCard(updatedCard)
    )
    .build();
}

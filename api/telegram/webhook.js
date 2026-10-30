
'use strict';

module.exports = async (req, res) => {
  try {
    const { getStore } = require('../../lib/getStore');
    const { analyze } = require('../../lib/detector');

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (
      process.env.TELEGRAM_WEBHOOK_SECRET &&
      secret !== process.env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.status(401).json({ ok: false });
    }

    const m = req.body?.message ||
              req.body?.channel_post ||
              req.body?.edited_message;

    if (!m) {
      return res.json({ ok: true, skipped: true });
    }

    const text = m.text || m.caption || '';
    const isPhoto = !!m.photo;
    const a = analyze(text);

    let imageLabels = [];
    let imageRisk = 0;
    let fileId = null;
    let fileUrl = null;

    if (isPhoto) {
      try {
        const vision = require('../../lib/vision');
        const largestPhoto = m.photo[m.photo.length - 1];
        const token = process.env.TELEGRAM_BOT_TOKEN;
        fileId = largestPhoto.file_id;

        const fileResp = await fetch(
          `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
        );
        const fileData = await fileResp.json();
        const filePath = fileData.result.file_path;
        fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

        const visionResult = await vision.analyzeImage(fileUrl);
        imageLabels = visionResult.labels || [];
        imageRisk = visionResult.risk || 0;
      } catch (e) {
        imageLabels = [`System Error: ${e.message}`];
        imageRisk = 5;

        if (m.photo) {
          fileId = m.photo[m.photo.length - 1].file_id;
        }
      }
    }

    const risk = Math.max(a.risk, imageRisk, 0);

    if (risk === 0) {
      return res.json({
        ok: true,
        skipped: true,
        persisted: false
      });
    }

    let level = 'low';
    if (risk >= 7) level = 'high';
    else if (risk >= 4) level = 'medium';

    const doc = {
      platform: 'telegram',
      chatId: String(m.chat?.id || ''),
      chatTitle: m.chat?.title || 'private',
      userId: String(m.from?.id || m.sender_chat?.id || ''),
      username: m.from?.username || m.from?.first_name || 'unknown',
      text: text || '[photo]',
      mediaType: isPhoto ? 'photo' : 'text',
      fileId,
      fileUrl,
      ts: new Date((m.date || Date.now() / 1000) * 1000),
      createdAt: new Date(),
      risk,
      level,
      categories: a.categories || [],
      matches: a.matches || [],
      identifiers: a.identifiers || {},
      reasons: a.reasons || [],
      imageLabels
    };

    const store = await getStore();
    await store.saveDetection(doc);

    return res.json({
      ok: true,
      skipped: false,
      result: {
        risk,
        level,
        categories: doc.categories,
        reasons: doc.reasons
      },
      persisted: true
    });
  } catch (err) {
    console.error('WEBHOOK CRASH:', err);
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};

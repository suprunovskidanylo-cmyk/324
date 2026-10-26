'use strict';
const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.NAUROK_PORT || 3219);
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
const MAX_BODY = 40_000;

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // The server binds only to loopback. Do not add public-interface binding.
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, configured: Boolean(API_KEY), model: MODEL });
  }
  if (req.method !== 'POST' || req.url !== '/answer') {
    return send(res, 404, { error: 'Not found' });
  }
  if (!API_KEY) return send(res, 500, { error: 'OPENAI_API_KEY is not set. See README.' });

  let raw = '';
  req.setEncoding('utf8');
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(res, 413, { error: 'Request too large' });
    }
    const data = JSON.parse(raw || '{}');
    const question = String(data.question || '').trim().slice(0, 12_000);
    const options = Array.isArray(data.options)
      ? data.options.map(x => String(x).trim().slice(0, 1_000)).slice(0, 12)
      : [];
    if (!question || options.length < 2 || options.some(x => !x)) {
      return send(res, 400, { error: 'Need a question and at least two non-empty options.' });
    }

    const input = [
      'Допоможи розібрати навчальне запитання. Визнач індекс або індекси правильних варіантів, починаючи з 0.',
      'Якщо запитання неоднозначне або даних недостатньо, поверни correctIndexes як [] і поясни невизначеність.',
      'Відповідай лише валідним JSON без Markdown у форматі: {"correctIndexes":[0],"explanation":"коротке пояснення українською"}.',
      'Запитання: ' + question,
      'Варіанти: ' + JSON.stringify(options.map((text, index) => ({ index, text }))),
      'Для завдання з однією відповіддю поверни один індекс; для завдання з кількома відповідями — усі правильні індекси.'
    ].join('\n\n');

    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: 'Ти уважний навчальний помічник. Перевіряй факти та обчислення. Не вигадуй; якщо не впевнений, скажи про це в поясненні й поверни порожній список індексів.',
        input,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const apiData = await apiResponse.json().catch(() => ({}));
    if (!apiResponse.ok) {
      const message = apiData?.error?.message || `OpenAI API returned HTTP ${apiResponse.status}`;
      return send(res, 502, { error: message });
    }
    const outputText = (apiData.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text')
      .map(part => part.text)
      .join('\n').trim();

    let result;
    try {
      const cleaned = outputText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      result = JSON.parse(cleaned);
    } catch {
      return send(res, 502, { error: 'Could not parse model response', raw: outputText.slice(0, 2000) });
    }

    const correctIndexes = Array.isArray(result.correctIndexes)
      ? [...new Set(result.correctIndexes.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < options.length))]
      : [];
    return send(res, 200, {
      correctIndexes,
      explanation: String(result.explanation || 'Пояснення не надано.').slice(0, 4000),
      model: MODEL,
      note: 'Відповідь моделі може бути помилковою; перевір пояснення.'
    });
  } catch (err) {
    return send(res, 500, { error: err?.name === 'TimeoutError' ? 'OpenAI request timed out' : 'Server error: ' + String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Naurok AI helper listening at http://${HOST}:${PORT}`);
  console.log(`Model: ${MODEL}`);
  if (!API_KEY) console.error('OPENAI_API_KEY is missing. Set it in Windows environment variables, then restart this server.');
});

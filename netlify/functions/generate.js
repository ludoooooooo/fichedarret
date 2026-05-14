const https = require('https');

function httpPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostForm(hostname, path, formBody) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(formBody);
    req.end();
  });
}

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Token cache (en mémoire, réinitialisé à chaque cold start)
let cachedToken = null;
let tokenExpiry = 0;

async function getJudilibreToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const CLIENT_ID     = process.env.PISTE_CLIENT_ID;
  const CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Clés PISTE manquantes');
  const form = `grant_type=client_credentials&client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&scope=openid`;
  const res = await httpPostForm('sandbox-oauth.piste.gouv.fr', '/api/oauth/token', form);
  if (res.status !== 200) throw new Error('OAuth PISTE échoué : ' + res.status);
  cachedToken = res.body.access_token;
  tokenExpiry = Date.now() + (res.body.expires_in || 3600) * 1000 - 30000;
  return cachedToken;
}

async function fetchDecision(number) {
  const token = await getJudilibreToken();
  const path = `/cassation/judilibre/v1.0/decision?number=${encodeURIComponent(number)}&resolve_references=false`;
  const res = await httpGet('sandbox-api.piste.gouv.fr', path, {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  });
  if (res.status !== 200) throw new Error('Judilibre ' + res.status);
  const results = res.body.results || [];
  if (!results.length) throw new Error('Décision introuvable');
  const d = results[0];
  return { text: d.text || d.summary || '', date: d.decision_date || d.date || '', chamber: d.chamber || d.formation || '', solution: d.solution || '' };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    const { pourvoi, examples = [] } = JSON.parse(event.body || '{}');
    if (!pourvoi) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Numéro de pourvoi manquant' }) };

    // 1. Judilibre
    let decisionText = null, decisionMeta = {};
    try {
      const d = await fetchDecision(pourvoi);
      decisionText = d.text;
      decisionMeta = { date: d.date, chamber: d.chamber, solution: d.solution };
    } catch(e) {
      console.log('Judilibre indisponible :', e.message);
    }

    // 2. Prompt
    const exPrompt = examples.length
      ? '\n\nExemples de fiches validées par l\'utilisateur (reproduire ce style exactement) :\n' +
        examples.slice(-5).map(e => JSON.stringify(e)).join('\n---\n')
      : '';

    const system = `Tu es un assistant juridique expert en droit français. Tu rédiges des fiches d'arrêt de la Cour de cassation en 6 sections.

Réponds UNIQUEMENT avec un objet JSON valide, sans backticks, sans commentaires :
{"presentation":"L'arrêt rendu par [chambre] de la Cour de cassation le [date] traite de [sujet court et précis].","faits":"En l'espèce, [faits pertinents — jamais la procédure dans cette section].","procedure":"[Chronologie des instances : qui assigne qui, décision du juge du fond avec motifs, puis pourvoi en cassation].","these":"[Arguments précis du demandeur au pourvoi : ce qu'il allègue, les articles prétendument violés par la CA].","question":"[Question de droit abstraite, généralisable, une seule phrase interrogative, sans noms de parties]","solution":"La [chambre] de la Cour de cassation répond par la [affirmative/négative] et [casse/rejette] au visa de [article] au motif que [motif juridique précis et complet].","type_arret":"cassation ou rejet"}

Règles : faits commencent par "En l'espèce,", question abstraite sans noms propres, solution avec visa et motif exact.${exPrompt}`;

    let userContent = `Numéro de pourvoi : ${pourvoi}\n\n`;
    if (decisionText) {
      userContent += `Texte officiel Judilibre :\n${decisionText.slice(0, 8000)}`;
      if (decisionMeta.date)     userContent += `\nDate : ${decisionMeta.date}`;
      if (decisionMeta.chamber)  userContent += `\nChambre : ${decisionMeta.chamber}`;
      if (decisionMeta.solution) userContent += `\nSolution officielle : ${decisionMeta.solution}`;
    } else {
      userContent += `Génère la fiche depuis tes connaissances. Si inconnue, indique "À vérifier sur Légifrance".`;
    }

    // 3. Claude
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) throw new Error('Clé Anthropic manquante');

    const claudeRes = await httpPost('api.anthropic.com', '/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userContent }]
    });

    if (claudeRes.status !== 200) throw new Error('Claude API ' + claudeRes.status + ' : ' + JSON.stringify(claudeRes.body));

    const raw = claudeRes.body.content?.[0]?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
    const jsonStr = start >= 0 && end >= 0 ? clean.slice(start, end + 1) : clean;
    const fiche = JSON.parse(jsonStr);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fiche, source: decisionText ? 'judilibre' : 'model' })
    };

  } catch(e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

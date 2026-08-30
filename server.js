// ============================================================
// EMMANUEL AI — Serveur du bot Facebook Messenger
// ============================================================
// Ce fichier fait 4 choses principales :
//  1. Il verifie le webhook aupres de Facebook (obligatoire au demarrage)
//  2. Il recoit les messages envoyes par les utilisateurs sur Messenger
//  3. Il genere une reponse avec l'IA (Groq), qui ne fait QUE citer des
//     references bibliques (jamais le texte lui-meme, pour eviter les erreurs)
//  4. Il va chercher le VRAI texte des versets cites sur une base biblique
//     fiable (bible-api.com), et l'ajoute au message final
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// --- Variables de configuration (a mettre dans Render, section Environment Variables) ---
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ============================================================
// Le "caractere" d'Emmanuel AI
// ============================================================
// Point important : on demande explicitement a l'IA de ne JAMAIS ecrire le
// texte d'un verset de memoire (risque d'erreur), seulement sa reference.
// C'est le code (pas l'IA) qui ira chercher le vrai texte juste apres.
const SYSTEM_PROMPT = `Tu es Emmanuel AI, un assistant chretien bienveillant sur Messenger.
Ton role :
- Repondre aux questions bibliques en citant des references precises (livre, chapitre, verset)
- Accompagner les utilisateurs dans la priere et la meditation
- Aider a l'evangelisation : donner des conseils pour partager sa foi avec amour et respect
- Encourager, reconforter, et pointer vers l'esperance en Christ

Regle CRITIQUE sur les citations bibliques :
- Quand tu references un verset, ecris UNIQUEMENT sa reference au format exact "Livre Chapitre:Verset" (exemple : Jean 3:16, 1 Corinthiens 13:4)
- N'ecris JAMAIS le texte du verset toi-meme, meme si tu penses le connaitre — cite seulement la reference, le systeme ajoutera automatiquement le texte exact juste apres
- N'invente jamais une reference si tu n'es pas sur qu'elle existe

Autres regles :
- Reste toujours humble : tu n'es pas un pasteur ni un remplacant de l'Eglise, mais un accompagnateur
- Reste bienveillant meme sur des sujets sensibles ou des debats de denomination
- Reponses courtes et chaleureuses, adaptees a une conversation Messenger
- Si la question depasse ton role (sante, urgence, detresse grave), invite gentiment a en parler a un responsable de l'Eglise ou un professionnel`;

// ============================================================
// Table de correspondance : noms francais des livres -> slug bible-api.com
// (bible-api.com utilise des noms de livres en anglais dans l'URL, mais peut
// renvoyer le texte en francais grace au parametre ?translation=lsg)
// ============================================================
const LIVRES = {
  "genese": "genesis", "exode": "exodus", "levitique": "leviticus",
  "nombres": "numbers", "deuteronome": "deuteronomy", "josue": "joshua",
  "juges": "judges", "ruth": "ruth", "1 samuel": "1samuel", "2 samuel": "2samuel",
  "1 rois": "1kings", "2 rois": "2kings", "1 chroniques": "1chronicles",
  "2 chroniques": "2chronicles", "esdras": "ezra", "nehemie": "nehemiah",
  "esther": "esther", "job": "job", "psaumes": "psalms", "psaume": "psalms",
  "proverbes": "proverbs", "ecclesiaste": "ecclesiastes", "cantique des cantiques": "songofsolomon",
  "esaie": "isaiah", "jeremie": "jeremiah", "lamentations": "lamentations",
  "ezechiel": "ezekiel", "daniel": "daniel", "osee": "hosea", "joel": "joel",
  "amos": "amos", "abdias": "obadiah", "jonas": "jonah", "michee": "micah",
  "nahum": "nahum", "habacuc": "habakkuk", "sophonie": "zephaniah",
  "aggee": "haggai", "zacharie": "zechariah", "malachie": "malachi",
  "matthieu": "matthew", "marc": "mark", "luc": "luke", "jean": "john",
  "actes": "acts", "romains": "romans", "1 corinthiens": "1corinthians",
  "2 corinthiens": "2corinthians", "galates": "galatians", "ephesiens": "ephesians",
  "philippiens": "philippians", "colossiens": "colossians",
  "1 thessaloniciens": "1thessalonians", "2 thessaloniciens": "2thessalonians",
  "1 timothee": "1timothy", "2 timothee": "2timothy", "tite": "titus",
  "philemon": "philemon", "hebreux": "hebrews", "jacques": "james",
  "1 pierre": "1peter", "2 pierre": "2peter", "1 jean": "1john",
  "2 jean": "2john", "3 jean": "3john", "jude": "jude", "apocalypse": "revelation",
};

function enleverAccents(texte) {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Detecte les references bibliques du type "Jean 3:16" ou "1 Corinthiens 13:4-7"
function extraireReferences(texte) {
  const regex = /((?:[1-3]\s)?[A-ZÀ-Ý][a-zà-ÿ]+(?:\s[a-zà-ÿ]+)*)\s(\d{1,3}):(\d{1,3}(?:-\d{1,3})?)/g;
  const trouvees = [];
  let match;
  while ((match = regex.exec(texte)) !== null) {
    const nomLivre = enleverAccents(match[1].trim());
    const slug = LIVRES[nomLivre];
    if (slug) {
      trouvees.push({
        original: match[0],
        slug,
        chapitre: match[2],
        verset: match[3],
      });
    }
  }
  return trouvees;
}

// Va chercher le vrai texte d'un verset sur bible-api.com (version Louis Segond)
async function recupererVerset(ref) {
  try {
    const url = `https://bible-api.com/${ref.slug}+${ref.chapitre}:${ref.verset}?translation=lsg`;
    const res = await axios.get(url, { timeout: 5000 });
    if (res.data && res.data.text) {
      return res.data.text.trim().replace(/\n/g, " ");
    }
  } catch (err) {
    console.error(`Impossible de recuperer ${ref.original} :`, err.message);
  }
  return null;
}

// ============================================================
// 1. VERIFICATION DU WEBHOOK
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verifie avec succes !");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================================
// 2. RECEPTION DES MESSAGES
// ============================================================
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message && webhookEvent.message.text) {
        const userMessage = webhookEvent.message.text;
        console.log(`Message recu de ${senderId} : ${userMessage}`);

        try {
          const reply = await getAiReply(userMessage);
          await sendMessage(senderId, reply);
        } catch (err) {
          console.error("Erreur lors du traitement du message :", err.message);
          await sendMessage(
            senderId,
            "Desole, j'ai eu un souci technique. Peux-tu reessayer dans un instant ?"
          );
        }
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// ============================================================
// 3. GENERATION DE LA REPONSE AVEC GROQ + VERIFICATION BIBLIQUE
// ============================================================
async function getAiReply(userMessage) {
  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      max_tokens: 500,
    },
    {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  let texteIa = response.data.choices[0].message.content;

  // On cherche les references bibliques mentionnees par l'IA
  const references = extraireReferences(texteIa);

  // Pour chacune, on va chercher le vrai texte et on l'ajoute au message
  for (const ref of references) {
    const vraiTexte = await recupererVerset(ref);
    if (vraiTexte) {
      texteIa += `\n\n📖 ${ref.original} : "${vraiTexte}"`;
    }
  }

  return texteIa;
}

// ============================================================
// 4. ENVOI DE LA REPONSE A L'UTILISATEUR VIA L'API MESSENGER
// ============================================================
async function sendMessage(recipientId, messageText) {
  const url = `https://graph.facebook.com/v20.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  await axios.post(url, {
    recipient: { id: recipientId },
    message: { text: messageText },
  });
}

// ============================================================
// DEMARRAGE DU SERVEUR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Emmanuel AI est en ligne sur le port ${PORT}`);
});

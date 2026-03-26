// ─── Privacy Consent System ────────────────────────────────────────────────────
// Every user must read and accept the privacy notice before PIXEL interacts
// with them, collects memory, or tracks their behaviour.
//
// Acceptance is stored permanently in PostgreSQL.
// Users can revoke at any time via !forget (wipes all their data).

import { pool } from "@workspace/db";
import { generateWithFallback } from "@workspace/integrations-gemini-ai";

// ── In-memory cache — avoids a DB round-trip on every message ─────────────────
const consentCache = new Set<string>();

// ── DB init ──────────────────────────────────────────────────────────────────
export async function initConsent(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_consent (
      user_id    TEXT PRIMARY KEY,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await pool.query(`SELECT user_id FROM user_consent`);
  for (const row of rows) consentCache.add(row.user_id);
  console.log(`Loaded ${rows.length} consent record(s) from DB`);
}

// ── Check ─────────────────────────────────────────────────────────────────────
export function hasConsented(userId: string): boolean {
  return consentCache.has(userId);
}

// ── Accept ────────────────────────────────────────────────────────────────────
export async function acceptConsent(userId: string): Promise<void> {
  consentCache.add(userId);
  await pool.query(
    `INSERT INTO user_consent (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  );
}

// ── Revoke (called from !forget) ──────────────────────────────────────────────
export async function revokeConsent(userId: string): Promise<void> {
  consentCache.delete(userId);
  await pool.query(`DELETE FROM user_consent WHERE user_id = $1`, [userId]);
}

// ─── Arabic dialect adapter ────────────────────────────────────────────────────
// One Gemini call per dialect — result cached forever (dialects don't change).
const arabicDialectCache = new Map<string, string>();

export async function getArabicNoticeForDialect(sampleText: string): Promise<string> {
  // Quick dialect fingerprint from the sample (first 200 chars is enough)
  const sample = sampleText.slice(0, 200);

  // Ask Gemini: identify dialect AND adapt the notice — single call
  const baseNotice = NOTICES["ar"]; // Jordanian version as the Arabic base
  try {
    const raw = (await generateWithFallback({
      contents: [{
        role: "user",
        parts: [{
          text:
            `A user sent this Arabic message:\n"${sample}"\n\n` +
            `First, identify their Arabic dialect in one word (e.g. egyptian, saudi, levantine, moroccan, gulf, iraqi, libyan, sudanese, yemeni, tunisian). ` +
            `If you can't tell, reply with "levantine".\n\n` +
            `Then, rewrite the following Discord privacy notice ONLY in that exact Arabic dialect. ` +
            `Keep all Discord markdown (**, \`, >, •) intact. Do NOT translate to MSA — use the natural spoken dialect.\n\n` +
            `Format your response EXACTLY as:\nDIALECT: <one word>\nNOTICE:\n<rewritten notice>\n\n` +
            `Privacy notice to rewrite:\n${baseNotice}`,
        }],
      }],
      maxOutputTokens: 1200,
    }))?.trim() ?? "";
    const dialectMatch = raw.match(/^DIALECT:\s*(\w+)/im);
    const noticeMatch  = raw.match(/^NOTICE:\s*([\s\S]+)/im);

    const dialect = dialectMatch?.[1]?.toLowerCase() ?? "levantine";
    const notice  = noticeMatch?.[1]?.trim() ?? baseNotice;

    // Cache by dialect so future users with the same dialect skip the AI call
    arabicDialectCache.set(dialect, notice);
    return notice;
  } catch {
    return baseNotice; // Fallback to Jordanian on any error
  }
}

// ─── DM-specific notice (shorter — no server admin / profiling context) ──────
const DM_NOTICES: Record<string, string> = {
  en: [
    `🔒 **Privacy Notice (Direct Message)**`,
    ``,
    `Before we chat, here's what PIXEL does in DMs:`,
    ``,
    `• **Conversation memory** — PIXEL remembers what you share across sessions so it can give you more personal responses.`,
    `• **No behavioural tracking** — DMs are private. No activity reports, no server admins involved.`,
    `• **Your data stays yours** — type \`!forget\` at any time to erase your entire memory instantly.`,
    ``,
    `**To accept and start chatting, type:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> If you decline, PIXEL will not reply and nothing will be saved.`,
  ].join("\n"),

  ar: [
    `🔒 **إشعار الخصوصية (رسالة خاصة)**`,
    ``,
    `قبل ما نحكي، هاد اللي بيعمله PIXEL بالرسائل الخاصة:`,
    ``,
    `• **ذاكرة المحادثة** — PIXEL بيتذكر اللي بتحكيه عشان يعطيك ردود أحسن وأشخصية.`,
    `• **ما في تتبع للنشاط** — الرسائل الخاصة خاصة. ما في تقارير ولا مشرفين.`,
    `• **بياناتك إلك** — اكتب \`!forget\` متى ما بدك تمسح كل الذاكرة على طول.`,
    ``,
    `**عشان توافق وتبدأ الحكي، اكتب:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> إذا ما وافقت، ما رح يرد عليك البوت وما رح يُحفظ إشي.`,
  ].join("\n"),
};

export function getDMPrivacyNotice(lang = "en"): string {
  return DM_NOTICES[lang] ?? DM_NOTICES["en"];
}

// ─── Language detection (Unicode-range heuristic) ─────────────────────────────
// Returns a BCP-47 language code from the dominant script in the text.
export function detectMessageLanguage(text: string): string {
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(text)) return "ar";  // Arabic
  if (/[\uAC00-\uD7A3\u1100-\u11FF]/.test(text))  return "ko";  // Korean
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text))  return "ja";  // Japanese (kana)
  if (/[\u4E00-\u9FFF]/.test(text))               return "zh";  // Chinese (CJK)
  if (/[\u0400-\u04FF]/.test(text))               return "ru";  // Russian / Cyrillic
  if (/[\u0900-\u097F]/.test(text))               return "hi";  // Hindi / Devanagari
  if (/[\u0600-\u06FF]/.test(text))               return "fa";  // Farsi (fallthrough)
  if (/[\u0E00-\u0E7F]/.test(text))               return "th";  // Thai
  if (/[\u0370-\u03FF]/.test(text))               return "el";  // Greek
  // For Latin-script languages we can't distinguish reliably without a library,
  // so fall back to English (the universal default).
  return "en";
}

// ─── Supported language list (shown in !privacy with no argument) ─────────────
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: "English",
  ar: "العربية",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  ru: "Русский",
  tr: "Türkçe",
  id: "Bahasa Indonesia",
  it: "Italiano",
  hi: "हिंदी",
};

// ─── Privacy notices (one per language) ───────────────────────────────────────
const NOTICES: Record<string, string> = {

  // ── English (canonical / fallback) ──────────────────────────────────────────
  en: [
    `⚠️ **Privacy Notice — Please read before continuing**`,
    ``,
    `PIXEL collects and analyses your interaction data. Here's exactly what happens:`,
    ``,
    `**📊 What is collected?**`,
    `• **Activity patterns** — hours you're active, daily message count`,
    `• **Conversation topics** — most-used keywords in your messages`,
    `• **Interaction style** — do you start conversations or reply to them?`,
    `• **Your interests** — what you voluntarily share with PIXEL (long-term memory)`,
    ``,
    `**🔒 Who can see this data?**`,
    `• Server admins can request a behavioural report with \`!profile @you\``,
    `• Used in daily server-wide summary reports`,
    `• PIXEL uses it to personalise responses for you`,
    ``,
    `**🗑️ Delete your data at any time:**`,
    `• \`!forget\` — wipes all your data and consent instantly`,
    ``,
    `**To agree and continue, type:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> If you decline, PIXEL will not interact with you and no data will be collected.`,
    ``,
    `*Available in other languages: \`!privacy <code>\` — e.g. \`!privacy ar\`*`,
    `*Supported: ${Object.entries(SUPPORTED_LANGUAGES).map(([k, v]) => `\`${k}\` ${v}`).join(" · ")}*`,
  ].join("\n"),

  // ── Arabic (Jordanian dialect) ────────────────────────────────────────────────
  ar: [
    `⚠️ **إشعار الخصوصية — لازم تقراه قبل ما تكمّل**`,
    ``,
    `PIXEL بيجمع ويحلل بيانات تفاعلك. هاد اللي رح يصير بالضبط:`,
    ``,
    `**📊 شو اللي بينجمع؟**`,
    `• **نمط نشاطك** — الساعات اللي بتكون فيها أونلاين، وعدد رسائلك اليومية`,
    `• **مواضيع حكيك** — الكلمات اللي بتكررها كتير بالرسائل`,
    `• **أسلوب تفاعلك** — هل إنت اللي بتبدأ الحكي، ولا بترد بس؟`,
    `• **اهتماماتك** — اللي بتحكيه لـ PIXEL من حالك (الذاكرة الدائمة)`,
    ``,
    `**🔒 مين بيشوف هاي البيانات؟**`,
    `• مشرفو السيرفر يقدروا يطلبوا تقرير عنك بالأمر \`!profile @انت\``,
    `• بتنستخدم بالتقارير اليومية للسيرفر`,
    `• PIXEL بيستخدمها عشان يخصص ردوده معك`,
    ``,
    `**🗑️ امسح بياناتك متى ما بدك:**`,
    `• \`!forget\` — بيمسح كل بياناتك وموافقتك على طول`,
    ``,
    `**عشان توافق وتكمّل، اكتب:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> إذا ما وافقت، ما رح يتفاعل معك البوت وما رح ينجمع عنك إشي.`,
  ].join("\n"),

  // ── Spanish ───────────────────────────────────────────────────────────────────
  es: [
    `⚠️ **Aviso de Privacidad — Léelo antes de continuar**`,
    ``,
    `PIXEL recopila y analiza tus datos de interacción. Esto es exactamente lo que ocurre:`,
    ``,
    `**📊 ¿Qué se recopila?**`,
    `• **Patrones de actividad** — horas activas, número de mensajes diarios`,
    `• **Temas de conversación** — palabras clave más usadas en tus mensajes`,
    `• **Estilo de interacción** — ¿inicias conversaciones o respondes?`,
    `• **Tus intereses** — lo que compartes voluntariamente con PIXEL (memoria a largo plazo)`,
    ``,
    `**🔒 ¿Quién puede ver estos datos?**`,
    `• Los admins del servidor pueden solicitar un informe con \`!profile @ti\``,
    `• Se usan en resúmenes diarios del servidor`,
    `• PIXEL los usa para personalizar sus respuestas contigo`,
    ``,
    `**🗑️ Elimina tus datos en cualquier momento:**`,
    `• \`!forget\` — borra todos tus datos y consentimiento al instante`,
    ``,
    `**Para aceptar y continuar, escribe:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Si rechazas, PIXEL no interactuará contigo y no se recopilarán datos.`,
  ].join("\n"),

  // ── French ───────────────────────────────────────────────────────────────────
  fr: [
    `⚠️ **Avis de Confidentialité — À lire avant de continuer**`,
    ``,
    `PIXEL collecte et analyse vos données d'interaction. Voici exactement ce qui se passe :`,
    ``,
    `**📊 Qu'est-ce qui est collecté ?**`,
    `• **Habitudes d'activité** — heures d'activité, nombre de messages quotidiens`,
    `• **Sujets de conversation** — mots-clés les plus utilisés dans vos messages`,
    `• **Style d'interaction** — initiez-vous des conversations ou y répondez-vous ?`,
    `• **Vos centres d'intérêt** — ce que vous partagez volontairement avec PIXEL (mémoire long terme)`,
    ``,
    `**🔒 Qui peut voir ces données ?**`,
    `• Les admins du serveur peuvent demander un rapport avec \`!profile @vous\``,
    `• Utilisés dans les résumés quotidiens du serveur`,
    `• PIXEL les utilise pour personnaliser ses réponses`,
    ``,
    `**🗑️ Supprimez vos données à tout moment :**`,
    `• \`!forget\` — efface toutes vos données et votre consentement instantanément`,
    ``,
    `**Pour accepter et continuer, tapez :**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Si vous refusez, PIXEL n'interagira pas avec vous et aucune donnée ne sera collectée.`,
  ].join("\n"),

  // ── German ───────────────────────────────────────────────────────────────────
  de: [
    `⚠️ **Datenschutzhinweis — Bitte vor dem Fortfahren lesen**`,
    ``,
    `PIXEL erfasst und analysiert deine Interaktionsdaten. Folgendes passiert dabei:`,
    ``,
    `**📊 Was wird gesammelt?**`,
    `• **Aktivitätsmuster** — aktive Stunden, tägliche Nachrichtenanzahl`,
    `• **Gesprächsthemen** — meistgenutzte Schlüsselwörter in deinen Nachrichten`,
    `• **Interaktionsstil** — startest du Gespräche oder antwortest du darauf?`,
    `• **Interessen** — was du PIXEL freiwillig mitteilst (Langzeitgedächtnis)`,
    ``,
    `**🔒 Wer kann diese Daten sehen?**`,
    `• Server-Admins können mit \`!profile @du\` einen Bericht anfordern`,
    `• Wird in täglichen Server-Zusammenfassungen verwendet`,
    `• PIXEL nutzt sie, um Antworten zu personalisieren`,
    ``,
    `**🗑️ Lösche deine Daten jederzeit:**`,
    `• \`!forget\` — löscht alle deine Daten und deine Einwilligung sofort`,
    ``,
    `**Um zuzustimmen und fortzufahren, schreibe:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Wenn du ablehnst, wird PIXEL nicht mit dir interagieren und keine Daten gesammelt.`,
  ].join("\n"),

  // ── Portuguese ───────────────────────────────────────────────────────────────
  pt: [
    `⚠️ **Aviso de Privacidade — Leia antes de continuar**`,
    ``,
    `PIXEL coleta e analisa seus dados de interação. Veja o que acontece exatamente:`,
    ``,
    `**📊 O que é coletado?**`,
    `• **Padrões de atividade** — horas ativas, contagem diária de mensagens`,
    `• **Tópicos de conversa** — palavras-chave mais usadas nas suas mensagens`,
    `• **Estilo de interação** — você inicia conversas ou responde a elas?`,
    `• **Seus interesses** — o que você compartilha voluntariamente com PIXEL (memória de longo prazo)`,
    ``,
    `**🔒 Quem pode ver esses dados?**`,
    `• Admins do servidor podem solicitar um relatório com \`!profile @você\``,
    `• Usado em resumos diários do servidor`,
    `• PIXEL usa para personalizar respostas para você`,
    ``,
    `**🗑️ Exclua seus dados a qualquer momento:**`,
    `• \`!forget\` — apaga todos os seus dados e consentimento instantaneamente`,
    ``,
    `**Para concordar e continuar, digite:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Se recusar, PIXEL não interagirá com você e nenhum dado será coletado.`,
  ].join("\n"),

  // ── Japanese ─────────────────────────────────────────────────────────────────
  ja: [
    `⚠️ **プライバシーのお知らせ — 続行前にお読みください**`,
    ``,
    `PIXELはあなたのインタラクションデータを収集・分析します。詳細は以下の通りです：`,
    ``,
    `**📊 収集されるもの**`,
    `• **活動パターン** — アクティブな時間帯、1日あたりのメッセージ数`,
    `• **会話のトピック** — メッセージ内で最も使用されるキーワード`,
    `• **インタラクションスタイル** — 会話を始めますか、それとも返信しますか？`,
    `• **あなたの興味** — PIXELに自発的に伝えた内容（長期記憶）`,
    ``,
    `**🔒 データを閲覧できる人**`,
    `• サーバー管理者は \`!profile @あなた\` でレポートを要求できます`,
    `• サーバーの日次サマリーレポートに使用されます`,
    `• PIXELがあなたへの返答をパーソナライズするために使用します`,
    ``,
    `**🗑️ いつでもデータを削除できます：**`,
    `• \`!forget\` — すべてのデータと同意を即座に削除`,
    ``,
    `**同意して続行するには、次を入力してください：**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> 拒否した場合、PIXELはあなたと対話せず、データは収集されません。`,
  ].join("\n"),

  // ── Korean ───────────────────────────────────────────────────────────────────
  ko: [
    `⚠️ **개인정보 보호 안내 — 계속하기 전에 읽어주세요**`,
    ``,
    `PIXEL은 귀하의 상호작용 데이터를 수집하고 분석합니다. 정확히 무슨 일이 일어나는지 알려드립니다:`,
    ``,
    `**📊 수집되는 항목**`,
    `• **활동 패턴** — 활동 시간대, 일일 메시지 수`,
    `• **대화 주제** — 메시지에서 가장 많이 사용되는 키워드`,
    `• **상호작용 스타일** — 대화를 시작하시나요, 아니면 답장하시나요?`,
    `• **관심사** — PIXEL에 자발적으로 공유한 내용 (장기 기억)`,
    ``,
    `**🔒 데이터를 볼 수 있는 사람**`,
    `• 서버 관리자는 \`!profile @당신\` 으로 행동 보고서를 요청할 수 있습니다`,
    `• 서버 일일 요약 보고서에 사용됩니다`,
    `• PIXEL이 응답을 개인화하는 데 사용됩니다`,
    ``,
    `**🗑️ 언제든지 데이터 삭제 가능:**`,
    `• \`!forget\` — 모든 데이터와 동의를 즉시 삭제`,
    ``,
    `**동의하고 계속하려면 다음을 입력하세요:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> 거부하면 PIXEL이 귀하와 상호작용하지 않으며 데이터가 수집되지 않습니다.`,
  ].join("\n"),

  // ── Chinese (Simplified) ──────────────────────────────────────────────────────
  zh: [
    `⚠️ **隐私声明 — 继续前请阅读**`,
    ``,
    `PIXEL 会收集并分析您的互动数据。以下是具体说明：`,
    ``,
    `**📊 收集内容**`,
    `• **活动规律** — 活跃时间段、每日消息数量`,
    `• **对话主题** — 消息中最常用的关键词`,
    `• **互动方式** — 您是发起对话还是回复对话？`,
    `• **您的兴趣** — 您主动分享给 PIXEL 的内容（长期记忆）`,
    ``,
    `**🔒 谁能看到这些数据？**`,
    `• 服务器管理员可通过 \`!profile @您\` 请求行为报告`,
    `• 用于每日服务器汇总报告`,
    `• PIXEL 用它为您个性化回复`,
    ``,
    `**🗑️ 随时删除您的数据：**`,
    `• \`!forget\` — 立即清除所有数据和同意记录`,
    ``,
    `**同意并继续，请输入：**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> 如果拒绝，PIXEL 将不与您互动，也不收集任何数据。`,
  ].join("\n"),

  // ── Russian ───────────────────────────────────────────────────────────────────
  ru: [
    `⚠️ **Уведомление о конфиденциальности — Прочитайте перед продолжением**`,
    ``,
    `PIXEL собирает и анализирует данные ваших взаимодействий. Вот что именно происходит:`,
    ``,
    `**📊 Что собирается?**`,
    `• **Паттерны активности** — часы активности, количество сообщений в день`,
    `• **Темы разговоров** — наиболее используемые ключевые слова`,
    `• **Стиль взаимодействия** — вы начинаете разговоры или отвечаете на них?`,
    `• **Ваши интересы** — что вы добровольно сообщаете PIXEL (долгосрочная память)`,
    ``,
    `**🔒 Кто видит эти данные?**`,
    `• Администраторы сервера могут запросить отчёт с помощью \`!profile @вы\``,
    `• Используется в ежедневных сводках сервера`,
    `• PIXEL использует для персонализации ответов`,
    ``,
    `**🗑️ Удалите данные в любое время:**`,
    `• \`!forget\` — мгновенно удаляет все данные и согласие`,
    ``,
    `**Чтобы согласиться и продолжить, введите:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Если откажетесь, PIXEL не будет взаимодействовать с вами и данные не будут собраны.`,
  ].join("\n"),

  // ── Turkish ───────────────────────────────────────────────────────────────────
  tr: [
    `⚠️ **Gizlilik Bildirimi — Devam etmeden önce okuyun**`,
    ``,
    `PIXEL etkileşim verilerinizi toplar ve analiz eder. İşte tam olarak neler olduğu:`,
    ``,
    `**📊 Ne toplanıyor?**`,
    `• **Aktivite kalıpları** — aktif saatler, günlük mesaj sayısı`,
    `• **Konuşma konuları** — mesajlarınızdaki en çok kullanılan anahtar kelimeler`,
    `• **Etkileşim tarzı** — sohbet başlatıyor musunuz yoksa yanıt mı veriyorsunuz?`,
    `• **İlgi alanlarınız** — PIXEL'e gönüllü olarak paylaştıklarınız (uzun süreli bellek)`,
    ``,
    `**🔒 Bu verileri kim görebilir?**`,
    `• Sunucu yöneticileri \`!profile @siz\` ile rapor isteyebilir`,
    `• Sunucunun günlük özet raporlarında kullanılır`,
    `• PIXEL yanıtları kişiselleştirmek için kullanır`,
    ``,
    `**🗑️ Verilerinizi istediğiniz zaman silin:**`,
    `• \`!forget\` — tüm verilerinizi ve onayınızı anında siler`,
    ``,
    `**Kabul etmek ve devam etmek için yazın:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Reddederseniz PIXEL sizinle etkileşime girmez ve hiçbir veri toplanmaz.`,
  ].join("\n"),

  // ── Indonesian ────────────────────────────────────────────────────────────────
  id: [
    `⚠️ **Pemberitahuan Privasi — Harap baca sebelum melanjutkan**`,
    ``,
    `PIXEL mengumpulkan dan menganalisis data interaksi Anda. Berikut yang terjadi:`,
    ``,
    `**📊 Apa yang dikumpulkan?**`,
    `• **Pola aktivitas** — jam aktif, jumlah pesan harian`,
    `• **Topik percakapan** — kata kunci yang paling sering digunakan`,
    `• **Gaya interaksi** — apakah Anda memulai percakapan atau membalasnya?`,
    `• **Minat Anda** — apa yang Anda bagikan secara sukarela ke PIXEL (memori jangka panjang)`,
    ``,
    `**🔒 Siapa yang bisa melihat data ini?**`,
    `• Admin server dapat meminta laporan dengan \`!profile @Anda\``,
    `• Digunakan dalam laporan harian server`,
    `• PIXEL menggunakannya untuk mempersonalisasi respons`,
    ``,
    `**🗑️ Hapus data Anda kapan saja:**`,
    `• \`!forget\` — menghapus semua data dan persetujuan Anda seketika`,
    ``,
    `**Untuk setuju dan melanjutkan, ketik:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Jika menolak, PIXEL tidak akan berinteraksi dan tidak ada data yang dikumpulkan.`,
  ].join("\n"),

  // ── Italian ───────────────────────────────────────────────────────────────────
  it: [
    `⚠️ **Informativa sulla Privacy — Leggi prima di continuare**`,
    ``,
    `PIXEL raccoglie e analizza i tuoi dati di interazione. Ecco cosa succede esattamente:`,
    ``,
    `**📊 Cosa viene raccolto?**`,
    `• **Schemi di attività** — ore di attività, numero di messaggi giornalieri`,
    `• **Argomenti di conversazione** — parole chiave più usate nei tuoi messaggi`,
    `• **Stile di interazione** — avvii conversazioni o rispondi?`,
    `• **I tuoi interessi** — ciò che condividi volontariamente con PIXEL (memoria a lungo termine)`,
    ``,
    `**🔒 Chi può vedere questi dati?**`,
    `• Gli admin del server possono richiedere un rapporto con \`!profile @tu\``,
    `• Usati nei resoconti giornalieri del server`,
    `• PIXEL li usa per personalizzare le risposte`,
    ``,
    `**🗑️ Elimina i tuoi dati in qualsiasi momento:**`,
    `• \`!forget\` — elimina tutti i tuoi dati e il consenso all'istante`,
    ``,
    `**Per accettare e continuare, scrivi:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> Se rifiuti, PIXEL non interagirà con te e non verranno raccolti dati.`,
  ].join("\n"),

  // ── Hindi ─────────────────────────────────────────────────────────────────────
  hi: [
    `⚠️ **गोपनीयता सूचना — जारी रखने से पहले पढ़ें**`,
    ``,
    `PIXEL आपके इंटरेक्शन डेटा को एकत्र और विश्लेषण करता है। यहाँ बताया गया है कि क्या होता है:`,
    ``,
    `**📊 क्या एकत्र किया जाता है?**`,
    `• **गतिविधि पैटर्न** — सक्रिय घंटे, दैनिक संदेश गिनती`,
    `• **बातचीत के विषय** — आपके संदेशों में सबसे अधिक उपयोग किए गए कीवर्ड`,
    `• **इंटरेक्शन शैली** — क्या आप बातचीत शुरू करते हैं या जवाब देते हैं?`,
    `• **आपकी रुचियाँ** — जो आप स्वेच्छा से PIXEL को बताते हैं (दीर्घकालिक स्मृति)`,
    ``,
    `**🔒 यह डेटा कौन देख सकता है?**`,
    `• सर्वर एडमिन \`!profile @आप\` से रिपोर्ट माँग सकते हैं`,
    `• सर्वर के दैनिक सारांश रिपोर्ट में उपयोग होता है`,
    `• PIXEL आपके लिए जवाब व्यक्तिगत बनाने के लिए उपयोग करता है`,
    ``,
    `**🗑️ किसी भी समय अपना डेटा मिटाएं:**`,
    `• \`!forget\` — सभी डेटा और सहमति तुरंत मिटा देता है`,
    ``,
    `**सहमत होने और जारी रखने के लिए टाइप करें:**`,
    `\`\`\``,
    `!accept`,
    `\`\`\``,
    `> यदि आप मना करते हैं, PIXEL आपसे इंटरेक्ट नहीं करेगा और कोई डेटा एकत्र नहीं होगा।`,
  ].join("\n"),
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Return the privacy notice in the requested language (falls back to English). */
export function getPrivacyNotice(lang = "en"): string {
  return NOTICES[lang.toLowerCase()] ?? NOTICES["en"];
}

/** Backward-compatible English notice (used where language is not needed). */
export const PRIVACY_NOTICE = NOTICES["en"];

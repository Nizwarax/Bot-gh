// ============================================================
// GITHUB MANAGER BOT - Versi VPS & Railway (Node.js)
// Long polling: tidak perlu webhook / domain.
// Penyimpanan: Redis (jika ada REDIS_URL) atau file JSON lokal.
// Jalankan: TG_TOKEN=xxxx node index.js
// ============================================================

const fs = require('fs');
const path = require('path');

const TG_TOKEN = process.env.TG_TOKEN || "";
const API = `https://api.telegram.org/bot${TG_TOKEN}`;
let KV; // di-set saat init

// ---------- KV BACKEND ----------
class FileKV {
  constructor() {
    this.file = path.join(__dirname, 'kv_data.json');
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.data)); }
  async get(k) { return this.data[k] ?? null; }
  async set(k, v) { this.data[k] = v; this.save(); }
  async del(k) { delete this.data[k]; this.save(); }
}

class RedisKV {
  constructor(url) {
    const Redis = require('ioredis');
    this.r = new Redis(url);
  }
  async get(k) {
    const v = await this.r.get(k);
    try { return v === null ? null : JSON.parse(v); } catch { return v; }
  }
  async set(k, v) { await this.r.set(k, JSON.stringify(v)); }
  async del(k) { await this.r.del(k); }
}

// ---------- HELPERS ----------
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function stringToBase64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function base64ToString(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }
async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}
async function sendReply(chatId, text, replyMarkup = null) {
  return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup, disable_web_page_preview: true });
}
async function sendDocumentBuffer(chatId, content, fileName) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', new Blob([content]), fileName);
  await fetch(`${API}/sendDocument`, { method: 'POST', body: fd });
}
async function deleteMessage(chatId, messageId) {
  await tg('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
}
async function answerCallback(id, text = '') {
  await tg('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {});
}
const kb = (rows) => ({ inline_keyboard: rows });
const btn = (text, cb) => ({ text, callback_data: cb });

// GitHub helpers
const ghHeaders = (token) => ({ 'Authorization': `token ${token}`, 'User-Agent': 'TG-Bot', 'Content-Type': 'application/json' });

async function deleteFolderRecursive(repo, token, folderPath) {
  const cleanPath = folderPath.replace(/^\/+|\/+$/g, '');
  const url = `https://api.github.com/repos/${repo}/contents/${cleanPath}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) { if (res.status === 404) return 0; throw new Error(`Gagal membaca folder ${cleanPath} (${res.status})`); }
  const items = await res.json();
  let deleted = 0;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item.type === 'dir') deleted += await deleteFolderRecursive(repo, token, item.path);
      else {
        const d = await fetch(`https://api.github.com/repos/${repo}/contents/${item.path}`, {
          method: 'DELETE', headers: ghHeaders(token),
          body: JSON.stringify({ message: `Delete ${item.path}`, sha: item.sha })
        });
        if (d.ok) deleted++;
      }
    }
  } else if (items.type === 'file') {
    const d = await fetch(`https://api.github.com/repos/${repo}/contents/${items.path}`, {
      method: 'DELETE', headers: ghHeaders(token),
      body: JSON.stringify({ message: `Delete ${items.path}`, sha: items.sha })
    });
    if (d.ok) deleted++;
  }
  return deleted;
}

async function downloadMedia(fileId) {
  const res = await fetch(`${API}/getFile?file_id=${fileId}`);
  if (!res.ok) throw new Error('Gagal mengambil info file dari Telegram.');
  const filePath = (await res.json()).result.file_path;
  const direct = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  return Buffer.from(await direct.arrayBuffer());
}

// ============================================================
// CALLBACK HANDLER
// ============================================================
async function handleCallbackQuery(cq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data;
  await answerCallback(cq.id);

  const key = `user_${chatId}`;
  let u = (await KV.get(key)) || {};

  if (data === 'goto_help') {
    await deleteMessage(chatId, messageId);
    return sendHelpMenu(chatId, !!u.repo);
  }

  if (!u.token) {
    return sendReply(chatId, `⚠️ <b>BELUM LOGIN</b>\n━━━━━━━━━━━━━━━━━━━━\nSilakan login terlebih dahulu menggunakan format:\n<code>/login username token_github</code>\natau\n<code>/login token_github</code>`);
  }

  if (data.startsWith('page:')) {
    await deleteMessage(chatId, messageId);
    return sendRepoMenu(chatId, u.token, parseInt(data.split(':')[1]));
  }

  if (data.startsWith('setrepo:')) {
    u.repo = data.split(':')[1]; u.current_path = ''; u.state = null;
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendFileMenu(chatId, u.repo, u.token, '', 1);
  }

  if (data.startsWith('repodetail:')) {
    await deleteMessage(chatId, messageId);
    return sendRepoDetail(chatId, data.split(':')[1], u.token);
  }

  if (data.startsWith('make_public:') || data.startsWith('make_private:')) {
    const isPriv = data.startsWith('make_private:');
    const repoName = data.split(':')[1];
    await answerCallback(cq.id, 'Mengubah visibilitas...');
    const res = await fetch(`https://api.github.com/repos/${repoName}`, {
      method: 'PATCH', headers: ghHeaders(u.token), body: JSON.stringify({ private: isPriv })
    });
    await deleteMessage(chatId, messageId);
    if (res.ok) {
      await sendReply(chatId, `${isPriv ? '🔒' : '🌐'} <b>BERHASIL</b>\n━━━━━━━━━━━━━━━━━━━━\nRepo <code>${escapeHtml(repoName)}</code> sekarang <b>${isPriv ? 'PRIVATE 🔒' : 'PUBLIC 🌐'}</b>.`);
      return sendRepoDetail(chatId, repoName, u.token);
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gagal ubah visibilitas (${res.status}): ${err.message}`);
  }

  if (data.startsWith('confirm_del:')) {
    const repoName = data.split(':')[1];
    await deleteMessage(chatId, messageId);
    return sendReply(chatId, `⚠️ <b>KONFIRMASI HAPUS REPOSITORY</b>\n━━━━━━━━━━━━━━━━━━━━\nHapus <code>${escapeHtml(repoName)}</code> secara permanen? Tindakan ini tidak bisa dibatalkan!`,
      kb([[btn('✅ Ya, Hapus Selamanya!', `do_del:${repoName}`), btn('❌ Batal', 'goto_repomenu')]]));
  }

  if (data.startsWith('do_del:')) {
    const repoName = data.split(':')[1];
    await answerCallback(cq.id, 'Menghapus repo...');
    const res = await fetch(`https://api.github.com/repos/${repoName}`, { method: 'DELETE', headers: ghHeaders(u.token) });
    await deleteMessage(chatId, messageId);
    if (res.ok) {
      if (u.repo === repoName) { u.repo = null; u.current_path = ''; await KV.set(key, u); }
      return sendReply(chatId, `🗑️ <b>BERHASIL</b>\n━━━━━━━━━━━━━━━━━━━━\nRepo <code>${escapeHtml(repoName)}</code> telah dihapus permanen.`,
        kb([[btn('🔙 Kembali ke Daftar Repo', 'goto_repomenu')]]));
    }
    const err = await res.json().catch(() => ({}));
    const reason = res.status === 403
      ? "<b>Token PAT tidak punya izin hapus!</b>\nCentang scope <code>delete_repo</code> (Classic) atau Administration → Read and write (Fine-grained), lalu login ulang."
      : `API GitHub menolak (${res.status}): ${escapeHtml(err.message || 'Izin ditolak')}`;
    return sendReply(chatId, `❌ <b>GAGAL MENGHAPUS</b>\n━━━━━━━━━━━━━━━━━━━━\n${reason}`,
      kb([[btn('🔙 Kembali', 'goto_repomenu')]]));
  }

  if (data === 'action_createrepo') {
    u.state = 'WAITING_FOR_NEW_REPO_NAME';
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendReply(chatId, `✨ <b>BUAT REPOSITORY BARU</b>\n━━━━━━━━━━━━━━━━━━━━\nKetik nama repo baru.\nFormat: <code>namarepo private</code> untuk private.\nContoh: <code>my-app private</code>`,
      kb([[btn('❌ Batal', 'goto_repomenu')]]));
  }

  if (data.startsWith('open_dir:')) {
    u.current_path = data.substring('open_dir:'.length);
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendFileMenu(chatId, u.repo, u.token, u.current_path, 1);
  }

  if (data.startsWith('filepage:')) {
    const [page, ...p] = data.split(':')[1].split(':');
    await deleteMessage(chatId, messageId);
    return sendFileMenu(chatId, u.repo, u.token, p.join(':'), parseInt(page));
  }

  if (data === 'back_dir') {
    const parts = (u.current_path || '').split('/').filter(Boolean);
    parts.pop();
    u.current_path = parts.join('/');
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendFileMenu(chatId, u.repo, u.token, u.current_path, 1);
  }

  if (data === 'menu_tambah_global') {
    u.state = 'WAITING_FOR_FILE';
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    const pathText = u.current_path ? `folder <code>${escapeHtml(u.current_path)}/</code>` : '<b>Root Folder</b>';
    return sendReply(chatId, `📝 <b>TAMBAH FILE / GAMBAR</b>\n━━━━━━━━━━━━━━━━━━━━\n📍 Target: ${pathText}\n\n👉 Kirim satu/banyak file atau foto sekaligus.\n👉 Atau ketik format: <code>namafile.js isi_script</code>\n\n📌 Mode upload aktif sampai klik tombol Selesai.`,
      kb([[btn('✅ Selesai / Kembali ke Folder', 'goto_filemenu')]]));
  }

  if (data === 'menu_buat_folder') {
    u.state = 'WAITING_FOR_FOLDER_NAME';
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendReply(chatId, `📁 <b>BUAT FOLDER BARU</b>\n━━━━━━━━━━━━━━━━━━━━\nKetik nama folder baru:`, kb([[btn('❌ Batal', 'goto_filemenu')]]));
  }

  if (data.startsWith('viewfile:')) {
    await deleteMessage(chatId, messageId);
    return sendViewFile(chatId, u.repo, u.token, data.substring('viewfile:'.length));
  }

  if (data.startsWith('dlfile:')) {
    const target = data.substring('dlfile:'.length);
    await answerCallback(cq.id, 'Mengunduh file...');
    const res = await fetch(`https://api.github.com/repos/${u.repo}/contents/${target}`, { headers: ghHeaders(u.token) });
    if (!res.ok) throw new Error(`Gagal mengunduh ${target}`);
    const fd = await res.json();
    await sendDocumentBuffer(chatId, base64ToString(fd.content), target.split('/').pop());
    return;
  }

  if (data.startsWith('editfile:')) {
    const target = data.substring('editfile:'.length);
    u.state = 'WAITING_FOR_FILE_EDIT'; u.target_path = target;
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    const res = await fetch(`https://api.github.com/repos/${u.repo}/contents/${target}`, { headers: ghHeaders(u.token) });
    if (!res.ok) throw new Error(`Gagal mengambil file (${res.status})`);
    const fd = await res.json();
    const isi = base64ToString(fd.content);
    if (isi.length > 3500) {
      await sendReply(chatId, `✏️ <b>EDIT FILE (Besar)</b>\n📄 <code>${escapeHtml(target)}</code>\n⚠️ ${isi.length} karakter. Download, edit, kirim kembali ke sini.`,
        kb([[btn('❌ Batal', 'goto_filemenu')]]));
      return sendDocumentBuffer(chatId, isi, target.split('/').pop());
    }
    return sendReply(chatId, `✏️ <b>EDIT FILE</b>\n📄 <code>${escapeHtml(target)}</code>\n\n<b>Cara 1:</b> Kirim file baru ke sini.\n<b>Cara 2:</b> Salin, edit, kirim kembali teksnya:\n\n<pre>${escapeHtml(isi)}</pre>`,
      kb([[btn('❌ Batal', 'goto_filemenu')]]));
  }

  if (data.startsWith('renamefile:')) {
    const target = data.substring('renamefile:'.length);
    u.state = 'WAITING_FOR_RENAME'; u.target_path = target;
    await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendReply(chatId, `✏️ <b>RENAME / MOVE</b>\n📄 Asal: <code>${escapeHtml(target)}</code>\n\nKetik path/nama baru:\nContoh: <code>src/index.js</code>`,
      kb([[btn('❌ Batal', 'goto_filemenu')]]));
  }

  if (data.startsWith('delfile:')) {
    const target = data.substring('delfile:'.length);
    await deleteMessage(chatId, messageId);
    return sendReply(chatId, `⚠️ <b>KONFIRMASI HAPUS</b>\nHapus <code>${escapeHtml(target)}</code>?`,
      kb([[btn('✅ Ya, Hapus!', `dodel_file:${target}`), btn('❌ Batal', 'goto_filemenu')]]));
  }

  if (data.startsWith('dodel_file:')) {
    const target = data.substring('dodel_file:'.length);
    await answerCallback(cq.id, 'Menghapus...');
    const res = await fetch(`https://api.github.com/repos/${u.repo}/contents/${target}`, { headers: ghHeaders(u.token) });
    if (!res.ok) throw new Error(`${target} tidak ditemukan.`);
    const info = await res.json();
    if (Array.isArray(info)) {
      const n = await deleteFolderRecursive(u.repo, u.token, target);
      await deleteMessage(chatId, messageId);
      await sendReply(chatId, `🗑️ <b>FOLDER DIHAPUS</b>\n${escapeHtml(target)} (${n} file) telah dihapus.`);
    } else {
      const d = await fetch(`https://api.github.com/repos/${u.repo}/contents/${target}`, {
        method: 'DELETE', headers: ghHeaders(u.token),
        body: JSON.stringify({ message: `Hapus ${target}`, sha: info.sha })
      });
      if (!d.ok) throw new Error('Gagal menghapus file.');
      await deleteMessage(chatId, messageId);
    }
    return sendFileMenu(chatId, u.repo, u.token, u.current_path || '', 1);
  }

  if (data === 'goto_repomenu') {
    u.state = null; await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendRepoMenu(chatId, u.token, 1);
  }

  if (data === 'goto_filemenu') {
    u.state = null; await KV.set(key, u);
    await deleteMessage(chatId, messageId);
    return sendFileMenu(chatId, u.repo, u.token, u.current_path || '', 1);
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
async function handleBotMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();
  const key = `user_${chatId}`;
  let u = (await KV.get(key)) || {};

  if (text === '/cancel') {
    u.state = null; u.target_path = null; await KV.set(key, u);
    return sendReply(chatId, `❌ <b>Aksi Dibatalkan</b>`,
      kb([[btn('🔙 Ke Menu Utama', u.repo ? 'goto_filemenu' : 'goto_repomenu')]]));
  }
  if (text === '/logout') {
    await KV.del(key);
    return sendReply(chatId, `🚪 <b>LOGOUT BERHASIL</b>\nSesi dan token kamu telah dihapus.`);
  }
  if (text === '/help' || text === '/start') {
    return sendHelpMenu(chatId, !!u.repo);
  }
  if (text === '/menu') {
    if (!u.token) return sendReply(chatId, `🔑 <b>BELUM LOGIN</b>\nLogin: <code>/login username token_github</code>`);
    return u.repo ? sendFileMenu(chatId, u.repo, u.token, u.current_path || '', 1) : sendRepoMenu(chatId, u.token, 1);
  }

  if (text.startsWith('/login')) {
    const args = text.split(/\s+/);
    let token = '';
    if (args.length === 2) token = args[1];
    else if (args.length >= 3) token = args[2];
    else throw new Error('Format login salah.\nGunakan: /login username token_github');
    const check = await fetch('https://api.github.com/user', { headers: ghHeaders(token) });
    if (!check.ok) throw new Error('Token GitHub tidak valid atau kadaluarsa!');
    const ud = await check.json();
    u = { user: ud.login, token, repo: null, current_path: '', state: null };
    await KV.set(key, u);
    await sendReply(chatId, `✅ <b>LOGIN SUKSES!</b>\n━━━━━━━━━━━━━━━━━━━━\nSelamat datang, <b>${escapeHtml(ud.name || ud.login)}</b> (@${escapeHtml(ud.login)})`);
    return sendRepoMenu(chatId, token, 1);
  }

  if (text === '/user') {
    if (!u.token) return sendReply(chatId, `🔑 <b>BELUM LOGIN</b>`);
    const res = await fetch('https://api.github.com/user', { headers: ghHeaders(u.token) });
    if (!res.ok) throw new Error('Gagal mengambil profil GitHub.');
    const usr = await res.json();
    return sendReply(chatId, `👤 <b>PROFIL GITHUB</b>\n━━━━━━━━━━━━━━━━━━━━\n📛 Nama: ${escapeHtml(usr.name || '-')}\n🪪 Username: <code>${escapeHtml(usr.login)}</code>\n📦 Public: ${usr.public_repos} | 🔒 Private: ${usr.total_private_repos || 0}\n👥 Followers: ${usr.followers} | Following: ${usr.following}\n🔗 ${usr.html_url}`,
      kb([[btn('📂 Lihat Repository', 'goto_repomenu')]]));
  }

  if (!u.token) {
    return sendReply(chatId, `🤖 Silakan login dulu:\n<code>/login username token_github</code>\n\nAtau ketik <code>/start</code>.`);
  }

  const currentPath = u.current_path ? `${u.current_path}/` : '';

  // --- UPLOAD / EDIT FILE ---
  if (u.state === 'WAITING_FOR_FILE' || u.state === 'WAITING_FOR_FILE_EDIT') {
    let inputName = '', b64 = '';

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      const buf = await downloadMedia(photo.file_id);
      b64 = buf.toString('base64');
      if (u.state === 'WAITING_FOR_FILE_EDIT') inputName = u.target_path.split('/').pop();
      else if (text && text.includes('.')) inputName = text;
      else inputName = `photo_${Date.now()}.jpg`;
    } else if (message.document) {
      inputName = message.document.file_name;
      const buf = await downloadMedia(message.document.file_id);
      b64 = buf.toString('base64');
    } else if (text) {
      if (u.state === 'WAITING_FOR_FILE_EDIT') {
        inputName = u.target_path.split('/').pop();
        b64 = stringToBase64(text);
      } else {
        const sp = text.indexOf(' ');
        if (sp === -1) throw new Error('Format salah!\nGunakan: <code>namafile.js isi_script</code>');
        inputName = text.substring(0, sp).trim();
        b64 = stringToBase64(text.substring(sp + 1).trim());
      }
    }

    const isEdit = u.state === 'WAITING_FOR_FILE_EDIT';
    const fullPath = isEdit ? u.target_path : `${currentPath}${inputName}`;
    if (isEdit) { u.state = null; u.target_path = null; }
    await KV.set(key, u);

    if (!inputName || !b64) throw new Error('Gagal membaca data file.');

    const ghUrl = `https://api.github.com/repos/${u.repo}/contents/${fullPath}`;
    const check = await fetch(ghUrl, { headers: ghHeaders(u.token) });
    const sha = check.ok ? (await check.json()).sha : null;
    const push = await fetch(ghUrl, {
      method: 'PUT', headers: ghHeaders(u.token),
      body: JSON.stringify({ message: 'Upload via Telegram Bot', content: b64, sha })
    });
    if (!push.ok) {
      const err = await push.json().catch(() => ({}));
      throw new Error(`GitHub menolak upload (${push.status}): ${err.message}`);
    }
    return sendReply(chatId, `✅ <b>BERHASIL UPLOAD!</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 File: <code>${escapeHtml(inputName)}</code>\n📍 Path: <code>${escapeHtml(fullPath)}</code>\n📦 Repo: <code>${escapeHtml(u.repo)}</code>\n\n<i>Mode upload masih aktif. Kirim file berikutnya atau klik Selesai.</i>`,
      kb([[btn('✅ Selesai / Kembali ke Folder', 'goto_filemenu')]]));
  }

  // --- BUAT FOLDER ---
  if (u.state === 'WAITING_FOR_FOLDER_NAME') {
    const folderName = text.replace(/\/$/, '');
    if (!folderName) throw new Error('Nama folder tidak boleh kosong.');
    const ghUrl = `https://api.github.com/repos/${u.repo}/contents/${currentPath}${folderName}/.gitkeep`;
    const push = await fetch(ghUrl, {
      method: 'PUT', headers: ghHeaders(u.token),
      body: JSON.stringify({ message: `Create folder ${folderName}`, content: stringToBase64('# keep') })
    });
    if (!push.ok) throw new Error('Gagal membuat folder di GitHub.');
    u.state = null; await KV.set(key, u);
    return sendFileMenu(chatId, u.repo, u.token, u.current_path || '', 1);
  }

  // --- BUAT REPO ---
  if (u.state === 'WAITING_FOR_NEW_REPO_NAME') {
    const parts = text.split(/\s+/);
    const repoName = parts[0];
    const isPriv = parts[1] && parts[1].toLowerCase() === 'private';
    if (!repoName) throw new Error('Nama repo tidak boleh kosong.');
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST', headers: ghHeaders(u.token),
      body: JSON.stringify({ name: repoName, private: !!isPriv, auto_init: true })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gagal membuat repo (${res.status}): ${err.message}`);
    }
    const rd = await res.json();
    u.state = null; u.repo = rd.full_name; u.current_path = '';
    await KV.set(key, u);
    await sendReply(chatId, `✨ <b>REPO BERHASIL DIBUAT!</b>\n📦 <code>${escapeHtml(rd.full_name)}</code>\n🔒 ${rd.private ? 'Private' : 'Public'}`);
    return sendFileMenu(chatId, u.repo, u.token, '', 1);
  }

  // --- RENAME ---
  if (u.state === 'WAITING_FOR_RENAME') {
    const oldPath = u.target_path;
    const newPath = text.trim();
    if (!newPath) throw new Error('Path baru tidak boleh kosong.');
    const oldRes = await fetch(`https://api.github.com/repos/${u.repo}/contents/${oldPath}`, { headers: ghHeaders(u.token) });
    if (!oldRes.ok) throw new Error('File lama tidak ditemukan.');
    const oldData = await oldRes.json();
    const create = await fetch(`https://api.github.com/repos/${u.repo}/contents/${newPath}`, {
      method: 'PUT', headers: ghHeaders(u.token),
      body: JSON.stringify({ message: `Rename ${oldPath} → ${newPath}`, content: oldData.content })
    });
    if (!create.ok) throw new Error('Gagal membuat file di lokasi baru.');
    await fetch(`https://api.github.com/repos/${u.repo}/contents/${oldPath}`, {
      method: 'DELETE', headers: ghHeaders(u.token),
      body: JSON.stringify({ message: `Delete ${oldPath}`, sha: oldData.sha })
    });
    u.state = null; u.target_path = null; await KV.set(key, u);
    return sendReply(chatId, `✅ <b>RENAME BERHASIL</b>\n📄 Lama: <code>${escapeHtml(oldPath)}</code>\n📄 Baru: <code>${escapeHtml(newPath)}</code>`,
      kb([[btn('🔙 Kembali ke Folder', 'goto_filemenu')]]));
  }

  return sendReply(chatId, `❓ Perintah tidak dikenali.\nKetik <code>/menu</code> atau <code>/help</code>.`);
}

// ============================================================
// RENDER MENU
// ============================================================
async function sendRepoMenu(chatId, token, page = 1) {
  const perPage = 5;
  const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: ghHeaders(token) });
  if (!res.ok) throw new Error('Gagal mengambil daftar repository.');
  const all = await res.json();
  const rows = [];
  const start = (page - 1) * perPage;
  const pageItems = all.slice(start, start + perPage);
  for (const r of pageItems) {
    rows.push([btn(`${r.private ? '🔒' : '🌐'} ${r.name}`, `setrepo:${r.full_name}`), btn('ℹ️', `repodetail:${r.full_name}`), btn('🗑️', `confirm_del:${r.full_name}`)]);
  }
  const nav = [];
  if (page > 1) nav.push(btn('⬅️ Prev', `page:${page - 1}`));
  if (start + perPage < all.length) nav.push(btn('➡️ Next', `page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn('✨ Buat Repository Baru', 'action_createrepo')]);
  rows.push([btn('📖 Bantuan', 'goto_help')]);
  return sendReply(chatId, `🚀 <b>GITHUB MANAGER BOT</b>\n━━━━━━━━━━━━━━━━━━━━\n📂 Daftar Repository (Hal ${page}/${Math.ceil(all.length / perPage) || 1})\nTotal: ${all.length} repo\n\nPilih repo:`, kb(rows));
}

async function sendRepoDetail(chatId, repoName, token) {
  const res = await fetch(`https://api.github.com/repos/${repoName}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error('Gagal mengambil detail repository.');
  const r = await res.json();
  const toggle = r.private ? btn('🌐 Ubah Jadi Public', `make_public:${r.full_name}`) : btn('🔒 Ubah Jadi Private', `make_private:${r.full_name}`);
  return sendReply(chatId, `ℹ️ <b>DETAIL REPOSITORY</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 <code>${escapeHtml(r.full_name)}</code>\n🔒 ${r.private ? 'Private 🔒' : 'Public 🌐'}\n⭐ ${r.stargazers_count} | 🍴 ${r.forks_count}\n🌿 Branch: <code>${escapeHtml(r.default_branch)}</code>\n📝 ${escapeHtml(r.description || '-')}\n🔗 ${r.html_url}`,
    kb([
      [btn('📂 Kelola File & Folder', `setrepo:${r.full_name}`)],
      [toggle],
      [btn('🗑️ Hapus Repository', `confirm_del:${r.full_name}`)],
      [btn('🔙 Kembali', 'goto_repomenu')]
    ]));
}

async function sendFileMenu(chatId, repoName, token, path = '', page = 1) {
  const perPage = 6;
  const res = await fetch(`https://api.github.com/repos/${repoName}/contents/${path}`, { headers: ghHeaders(token) });
  if (!res.ok && res.status !== 404) throw new Error(`Gagal membaca repo (${res.status}).`);
  const rows = [];
  let listText = '';
  if (path) rows.push([btn('⬅️ Up Folder', 'back_dir')]);
  if (res.ok) {
    let items = await res.json();
    if (!Array.isArray(items)) items = [items];
    items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1));
    const start = (page - 1) * perPage;
    const pageItems = items.slice(start, start + perPage);
    for (const item of pageItems) {
      if (item.type === 'dir') {
        listText += `├ 📁 <b>${escapeHtml(item.name)}</b>\n`;
        rows.push([btn(`📁 ${item.name}`, `open_dir:${item.path}`), btn('🗑️', `delfile:${item.path}`)]);
      } else if (item.name !== '.gitkeep') {
        listText += `├ 📄 <code>${escapeHtml(item.name)}</code>\n`;
        rows.push([btn(`📄 ${item.name}`, `viewfile:${item.path}`)]);
        rows.push([btn('✏️', `editfile:${item.path}`), btn('🔤', `renamefile:${item.path}`), btn('🗑️', `delfile:${item.path}`)]);
      }
    }
    const nav = [];
    if (page > 1) nav.push(btn('⬅️ Prev', `filepage:${page - 1}:${path}`));
    if (start + perPage < items.length) nav.push(btn('➡️ Next', `filepage:${page + 1}:${path}`));
    if (nav.length) rows.push(nav);
  }
  if (!listText) listText = '<i>( Folder kosong )</i>\n';
  rows.push([btn('➕ Upload File / Foto', 'menu_tambah_global'), btn('📁 Buat Folder', 'menu_buat_folder')]);
  rows.push([btn('🔙 Ke Daftar Repo', 'goto_repomenu'), btn('📖 Bantuan', 'goto_help')]);
  const displayPath = path ? `/${path}` : '/ (Root)';
  return sendReply(chatId, `🛠️ <b>WORKSPACE</b>\n━━━━━━━━━━━━━━━━━━━━\n📦 <code>${escapeHtml(repoName)}</code>\n📍 <code>${escapeHtml(displayPath)}</code>\n━━━━━━━━━━━━━━━━━━━━\n${listText}`, kb(rows));
}

async function sendViewFile(chatId, repoName, token, filePath) {
  const res = await fetch(`https://api.github.com/repos/${repoName}/contents/${filePath}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error('Gagal mengambil file.');
  const d = await res.json();
  let content;
  if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(filePath)) {
    content = `🖼️ <i>File gambar (${d.size} bytes). Gunakan tombol Download.</i>`;
  } else {
    try {
      const c = base64ToString(d.content);
      content = c.length > 3500 ? `<i>Terlalu panjang (${c.length} karakter). Gunakan Download.</i>` : `<pre>${escapeHtml(c)}</pre>`;
    } catch { content = '<i>File binary.</i>'; }
  }
  return sendReply(chatId, `📄 <b>LIHAT FILE</b>\n━━━━━━━━━━━━━━━━━━━━\n📄 <code>${escapeHtml(filePath)}</code>\n📏 ${d.size} bytes\n━━━━━━━━━━━━━━━━━━━━\n${content}`,
    kb([
      [btn('✏️ Edit', `editfile:${filePath}`), btn('📥 Download', `dlfile:${filePath}`)],
      [btn('🔤 Rename', `renamefile:${filePath}`), btn('🗑️ Hapus', `delfile:${filePath}`)],
      [btn('🔙 Kembali', 'goto_filemenu')]
    ]));
}

async function sendHelpMenu(chatId, hasRepo) {
  return sendReply(chatId, `✨ <b>PANDUAN BOT GITHUB</b> ✨\n━━━━━━━━━━━━━━━━━━━━\n⚡ /menu — Buka workspace\n🔑 /login — <code>/login username token_github</code>\n👤 /user — Profil GitHub\n❌ /cancel — Batalkan aksi\n🚪 /logout — Keluar\n\n📤 <b>Upload banyak file:</b>\n1️⃣ /menu → pilih repo\n2️⃣ Klik ➕ Upload File / Foto\n3️⃣ Kirim file/foto sekaligus\n4️⃣ Klik ✅ Selesai\n\n📄 <b>Upload via teks:</b>\n<code>index.js console.log("hai");</code>\n\n🗑️ <b>Hapus repo:</b> butuh PAT dengan scope <code>delete_repo</code>.`,
    kb([[btn('🚀 Masuk Menu Utama', hasRepo ? 'goto_filemenu' : 'goto_repomenu')]]));
}

// ============================================================
// LONG POLLING LOOP
// ============================================================
async function poll(offset) {
  const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
  const data = await res.json();
  return data.result || [];
}

async function main() {
  if (!TG_TOKEN) {
    console.error('❌ TG_TOKEN belum di-set! Jalankan: TG_TOKEN=token_kamu node index.js');
    process.exit(1);
  }
  if (process.env.REDIS_URL) {
    KV = new RedisKV(process.env.REDIS_URL);
    console.log('✅ Penyimpanan: Redis');
  } else {
    KV = new FileKV();
    console.log('✅ Penyimpanan: file lokal (kv_data.json)');
  }

  const me = await tg('getMe', {});
  if (!me.ok) { console.error('❌ Token Telegram tidak valid!'); process.exit(1); }
  console.log(`🤖 Bot @${me.result.username} berjalan (long polling)...`);

  let offset = 0;
  while (true) {
    try {
      const updates = await poll(offset);
      for (const upd of updates) {
        offset = upd.update_id + 1;
        try {
          if (upd.callback_query) await handleCallbackQuery(upd.callback_query);
          else if (upd.message) await handleBotMessage(upd.message);
        } catch (e) {
          console.error('Error:', e.message);
          const chatId = upd.message?.chat?.id || upd.callback_query?.message?.chat?.id;
          if (chatId) await sendReply(chatId, `⚠️ <b>ERROR SISTEM</b>\n\n<code>${escapeHtml(e.message)}</code>`).catch(() => {});
        }
      }
    } catch (e) {
      console.error('Polling error, ulang dalam 5 detik:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();

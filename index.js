require('./settings');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const chalk = require('chalk');
const { createServer } = require('http');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { toBuffer } = require('qrcode');
const { exec } = require('child_process');
const {
    default: WAConnection,
    useMultiFileAuthState,
    Browsers,
    DisconnectReason,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require('baileys');

const DataBase = require('./src/database');
const { GroupCacheUpdate, GroupParticipantsUpdate, MessagesUpsert, Solving } = require('./src/message');
const database = new DataBase(global.tempatDB);
const packageInfo = require('./package.json');
const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

let lastQR = null;
app.get('/qr', async (req, res) => {
	if (!lastQR) return res.send('QR belum tersedia!');
	res.setHeader('Content-Type', 'image/png');
	res.end(await toBuffer(lastQR));
});

app.get('/', (req, res) => {
	if (process.send) {
		process.send('uptime');
		process.once('message', (uptime) => {
			res.json({
				bot_name: packageInfo.name,
				version: packageInfo.version,
				author: packageInfo.author,
				description: packageInfo.description,
				uptime: `${Math.floor(uptime)} seconds`
			});
		});
	} else {
		res.json({ error: 'Process not running with IPC' });
	}
});

server.listen(PORT, () => {
	console.log('✅ App berjalan di port', PORT);
});

async function startFaridBot() {
	const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) });
	const { state, saveCreds } = await useMultiFileAuthState('fariddev');
	const { version } = await fetchLatestBaileysVersion();
	const level = pino({ level: 'silent' });

	try {
		const loadData = await database.read();
		global.db = Object.keys(loadData || {}).length ? loadData : {
			hit: {}, set: {}, users: {}, game: {}, groups: {}, database: {}, premium: [], sewa: []
		};
		await database.write(global.db);

		setInterval(async () => {
			if (global.db) await database.write(global.db);
		}, 30 * 1000);
	} catch (e) {
		console.log(e);
		process.exit(1);
	}

	const getMessage = async (key) => {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid, key.id);
			return msg?.message || '';
		}
		return { conversation: 'Halo Saya Ti Assistant' };
	};

	const farid = WAConnection({
		logger: level,
		getMessage,
		syncFullHistory: true,
		maxMsgRetryCount: 15,
		msgRetryCounterCache,
		retryRequestDelayMs: 10,
		connectTimeoutMs: 60000,
		printQRInTerminal: true,
		browser: Browsers.ubuntu('Chrome'),
		generateHighQualityLinkPreview: true,
		cachedGroupMetadata: async (jid) => groupCache.get(jid),
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, level)
		}
	});

	store.bind(farid.ev);
	farid.ev.on('creds.update', saveCreds);

	await Solving(farid, store);

	farid.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, qr } = update;

		if (qr) {
			lastQR = qr;
			console.log(chalk.green('📲 QR tersedia. Scan di terminal atau buka /qr'));
		}

		if (connection === 'open') {
			console.log('✅ Terhubung sebagai:', JSON.stringify(farid.user, null, 2));
		}

		if (connection === 'close') {
			const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
			console.log(chalk.red(`❌ Koneksi terputus. Reason: ${reason}`));

			if ([DisconnectReason.connectionLost, DisconnectReason.restartRequired, DisconnectReason.connectionClosed, DisconnectReason.timedOut, DisconnectReason.badSession].includes(reason)) {
				console.log('🔁 Menghubungkan ulang...');
				startFaridBot();
			} else {
				console.log('❌ Tidak bisa reconnect otomatis. Hapus session dan scan ulang.');
				exec('rm -rf fariddev/*');
				process.exit(1);
			}
		}
	});

	farid.ev.on('messages.upsert', (msg) => MessagesUpsert(farid, msg, store, groupCache));
	farid.ev.on('groups.update', (update) => GroupCacheUpdate(farid, update, store, groupCache));
	farid.ev.on('group-participants.update', (update) => GroupParticipantsUpdate(farid, update, store, groupCache));

	setInterval(async () => {
		await farid.sendPresenceUpdate('available', farid.decodeJid(farid.user.id)).catch(() => {})
	}, 10 * 60 * 1000);

	return farid;
}

startFaridBot();

process.on('exit', async () => {
	if (global.db) await database.write(global.db);
	console.log('Cleaning up... Closing server.');
	server.close(() => {
		console.log('Server closed successfully.');
	});
});

process.on('SIGINT', async () => {
	if (global.db) await database.write(global.db);
	console.log('Received SIGINT. Closing server...');
	server.close(() => {
		console.log('Server closed. Exiting process.');
		process.exit(0);
	});
});

server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.log(`Address localhost:${PORT} sudah digunakan. Ubah port atau matikan proses lain.`);
		server.close();
	} else console.error('Server error:', error);
});

fs.watchFile(__filename, () => {
	fs.unwatchFile(__filename);
	console.log(chalk.redBright(`Update terdeteksi di ${__filename}`));
	delete require.cache[require.resolve(__filename)];
	require(__filename);
});

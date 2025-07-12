require('./settings');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const express = require('express');
const { createServer } = require('http');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { toBuffer } = require('qrcode');
const { exec } = require('child_process');
const { default: WAConnection, useMultiFileAuthState, Browsers, DisconnectReason, makeInMemoryStore, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('baileys');

const DataBase = require('./src/database');
const packageInfo = require('./package.json');
const database = new DataBase(global.tempatDB);
const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

let app = express();
let server = createServer(app);
let PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

global.fetchApi = async (path = '/', query = {}, options) => {
	const urlnya = (options?.name || options ? ((options?.name || options) in global.APIs ? global.APIs[(options?.name || options)] : (options?.name || options)) : global.APIs['hitori'] ? global.APIs['hitori'] : (options?.name || options)) + path + (query ? '?' + decodeURIComponent(new URLSearchParams(Object.entries({ ...query }))) : '')
	const { data } = await axios.get(urlnya, { ...((options?.name || options) ? {} : { headers: { 'accept': 'application/json', 'x-api-key': global.APIKeys[global.APIs['hitori']]}})})
	return data
}

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
	console.log('App listened on port', PORT);
});

const { GroupCacheUpdate, GroupParticipantsUpdate, MessagesUpsert, Solving } = require('./src/message');
const { isUrl, generateMessageTag, getBuffer, getSizeMedia, fetchJson, sleep } = require('./lib/function');

async function startFaridBot() {
	const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) })
	const { state, saveCreds } = await useMultiFileAuthState('fariddev');
	const { version, isLatest } = await fetchLatestBaileysVersion();
	const level = pino({ level: 'silent' });

	try {
		const loadData = await database.read()
		if (loadData && Object.keys(loadData).length === 0) {
			global.db = {
				hit: {},
				set: {},
				users: {},
				game: {},
				groups: {},
				database: {},
				premium: [],
				sewa: [],
				...(loadData || {}),
			}
			await database.write(global.db)
		} else {
			global.db = loadData
		}
		setInterval(async () => {
			if (global.db) await database.write(global.db)
		}, 30 * 1000)
	} catch (e) {
		console.log(e)
		process.exit(1)
	}

	const getMessage = async (key) => {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid, key.id);
			return msg?.message || ''
		}
		return {
			conversation: 'Halo Saya Ti Assistant'
		}
	}

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
		transactionOpts: {
			maxCommitRetries: 10,
			delayBetweenTriesMs: 10,
		},
		appStateMacVerification: {
			patch: true,
			snapshot: true,
		},
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, level),
		},
	})

	store.bind(farid.ev)
	await Solving(farid, store)
	farid.ev.on('creds.update', saveCreds)

	farid.ev.on('connection.update', async (update) => {
		const { qr, connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;

		if (qr) {
			app.use('/qr', async (req, res) => {
				res.setHeader('content-type', 'image/png');
				res.end(await toBuffer(qr));
			});
		}

		if (connection === 'close') {
			const reason = new Boom(lastDisconnect?.error)?.output.statusCode
			if (reason === DisconnectReason.connectionLost || reason === DisconnectReason.connectionClosed || reason === DisconnectReason.timedOut || reason === DisconnectReason.restartRequired || reason === DisconnectReason.badSession) {
				console.log('Reconnecting...');
				startFaridBot()
			} else if ([DisconnectReason.loggedOut, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(reason)) {
				console.log('Session ended. Please scan QR again.');
				exec('rm -rf ./fariddev/*')
				process.exit(1)
			} else {
				farid.end(`Unknown DisconnectReason: ${reason} | ${connection}`);
			}
		}

		if (connection === 'open') {
			console.log('Connected to : ' + JSON.stringify(farid.user, null, 2));
		}

		if (isNewLogin) console.log(chalk.green('New device login detected...'));
		if (receivedPendingNotifications === 'true') {
			console.log('Please wait About 1 Minute...');
			farid.ev.flush();
		}
	});

	farid.ev.on('contacts.update', (update) => {
		for (let contact of update) {
			let id = farid.decodeJid(contact.id)
			if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
		}
	});

	farid.ev.on('call', async (call) => {
		let botNumber = await farid.decodeJid(farid.user.id);
		if (global.db?.set[botNumber]?.anticall) {
			for (let id of call) {
				if (id.status === 'offer') {
					let msg = await farid.sendMessage(id.from, { text: `Maaf, saya tidak menerima panggilan.` });
					await farid.rejectCall(id.id, id.from);
				}
			}
		}
	});

	farid.ev.on('messages.upsert', async (message) => {
		await MessagesUpsert(farid, message, store, groupCache);
	});

	farid.ev.on('groups.update', async (update) => {
		await GroupCacheUpdate(farid, update, store, groupCache);
	});

	farid.ev.on('group-participants.update', async (update) => {
		await GroupParticipantsUpdate(farid, update, store, groupCache);
	});

	setInterval(async () => {
		await farid.sendPresenceUpdate('available', farid.decodeJid(farid.user.id)).catch(() => {})
	}, 10 * 60 * 1000);

	return farid;
}

startFaridBot()

process.on('exit', async () => {
	if (global.db) await database.write(global.db)
	console.log('Cleaning up... Closing server.');
	server.close(() => {
		console.log('Server closed successfully.');
	});
});
process.on('SIGINT', async () => {
	if (global.db) await database.write(global.db)
	console.log('Received SIGINT. Closing server...');
	server.close(() => {
		console.log('Server closed. Exiting process.');
		process.exit(0);
	});
});

server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.log(`Address localhost:${PORT} in use. Please retry when the port is available!`);
		server.close();
	} else console.error('Server error:', error);
});

setInterval(() => {}, 1000 * 60 * 10);
let file = require.resolve(__filename)
fs.watchFile(file, () => {
	fs.unwatchFile(file)
	console.log(chalk.redBright(`Update ${__filename}`))
	delete require.cache[file]
	require(file)
});

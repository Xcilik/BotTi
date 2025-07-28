require('./settings');
const fs = require('fs');
const pino = require('pino');
const express = require('express');
const chalk = require('chalk');
const { createServer } = require('http');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { exec } = require('child_process');
const {
    default: makeWASocket,
    useSingleFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    makeInMemoryStore
} = require('@adiwajshing/baileys');

const DataBase = require('./src/database');
const { GroupCacheUpdate, GroupParticipantsUpdate, MessagesUpsert, Solving } = require('./src/message');
const database = new DataBase(global.tempatDB);
const packageInfo = require('./package.json');

const msgRetryCounterCache = new NodeCache();
const groupCache = new NodeCache({ stdTTL: 5 * 60, useClones: false });

const { state, saveState } = useSingleFileAuthState('fariddev/session.json');
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });
store.readFromFile('./store.json');
setInterval(() => store.writeToFile('./store.json'), 30_000);

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

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
    const { version } = await fetchLatestBaileysVersion();
    const farid = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        auth: state,
        version,
        msgRetryCounterCache
    });

    store.bind(farid.ev);

    farid.ev.on('creds.update', saveState);

    try {
        const loadData = await database.read();
        global.db = Object.keys(loadData || {}).length ? loadData : {
            hit: {}, set: {}, users: {}, game: {}, groups: {}, database: {}, premium: [], sewa: []
        };
        await database.write(global.db);

        setInterval(async () => {
            if (global.db) await database.write(global.db);
        }, 30_000);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }

    farid.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log(chalk.greenBright('✅ Terhubung sebagai:'), JSON.stringify(farid.user, null, 2));
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(chalk.red(`❌ Koneksi terputus. Reason: ${reason}`));

            if ([DisconnectReason.badSession, 405].includes(reason)) {
                console.log('🧹 Session rusak. Menghapus dan keluar...');
                exec('rm -rf fariddev/', () => {
                    console.log('✅ Jalankan ulang dan scan QR baru.');
                    process.exit(0);
                });
            } else if (
                [DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired, DisconnectReason.timedOut].includes(reason)
            ) {
                console.log('🔁 Mencoba hubungkan ulang...');
                startFaridBot();
            } else {
                console.log('❌ Disconnect tidak diketahui:', reason);
                process.exit(1);
            }
        }
    });

    farid.ev.on('messages.upsert', (msg) => MessagesUpsert(farid, msg, store, groupCache));
    farid.ev.on('groups.update', (update) => GroupCacheUpdate(farid, update, store, groupCache));
    farid.ev.on('group-participants.update', (update) => GroupParticipantsUpdate(farid, update, store, groupCache));

    setInterval(async () => {
        await farid.sendPresenceUpdate('available', farid.decodeJid(farid.user.id)).catch(() => {});
    }, 10 * 60 * 1000);
}

startFaridBot();

process.on('exit', async () => {
    if (global.db) await database.write(global.db);
    console.log('Cleaning up... Closing server.');
    server.close(() => console.log('Server closed successfully.'));
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
        console.log(`❌ Port ${PORT} sudah digunakan. Gunakan port lain.`);
        server.close();
    } else {
        console.error('Server error:', error);
    }
});

fs.watchFile(__filename, () => {
    fs.unwatchFile(__filename);
    console.log(chalk.redBright(`🔁 File ${__filename} diperbarui. Restart...`));
    delete require.cache[require.resolve(__filename)];
    require(__filename);
});

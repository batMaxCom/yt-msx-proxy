const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');

const settingsPath = path.join(__dirname, './back/settings.json');

if (!fs.existsSync(path.join(__dirname, 'back'))) {
    fs.mkdirSync(path.join(__dirname, 'back'));
}

function getLocalIp() {
    return new Promise((resolve, reject) => {
        const platform = process.platform;

        if (platform === 'linux' || platform === 'darwin') {

            exec("hostname -I | awk '{print $1}'", (error, stdout, stderr) => {
                if (error) {
                    reject(`Error getting IP: ${stderr}`);
                } else {
                    resolve(stdout.trim());
                }
            });
        } else if (platform === 'win32') {

            exec("ipconfig | findstr /R /C:\"IPv4\" ", (error, stdout, stderr) => {
                if (error) {
                    reject(`Error getting IP: ${stderr}`);
                } else {
                    const ipMatch = stdout.match(/(?:\d{1,3}\.){3}\d{1,3}/);
                    resolve(ipMatch ? ipMatch[0] : 'localhost');
                }
            });
        } else {
            reject('Unsupported platform');
        }
    });
}

function promptUser(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdouts
    });

    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

async function setup() {
    try {
        let currentIp = await getLocalIp();
        console.log(`Current local IP address: ${currentIp}`);

        let settings;

        if (!fs.existsSync(settingsPath)) {
            const defaultSettings = { 
                serverIp: 'localhost',  
                expBrowse: false      
            };
            fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
            console.log("Created settings.json with default serverIp = localhost and expBrowse = false.");
            settings = defaultSettings;
        } else {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            console.log(`Current settings in settings.json: ${JSON.stringify(settings, null, 4)}`);
        }
        
        const newIp = await promptUser(`Current server IP is: ${settings.serverIp}. Do you want to set a custom IP? (default: localhost): `);

        if (newIp && newIp.trim() !== '') {
            settings.serverIp = newIp.trim();
        }

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        console.log(`Updated settings.json with serverIp: ${settings.serverIp}`);

    } catch (err) {
        console.error('Error during setup:', err);
    }
}

setup();
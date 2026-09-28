const axios = require('axios'); 
const fs = require('fs'); 
const path = require('path'); 

const settingsPath = path.join(__dirname, 'settings.json');

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
}

const serverIp = settings.serverIp || "localhost";

const BROWSE_FIXTURE = path.join(__dirname, '..', 'assets', 'browse_example_client6.json');

async function fetchBrowseData() {
    try {
        // Read the fixture from disk. This used to be an HTTP request back to
        // our own public address, which cost a round trip, hardcoded the
        // public origin, and broke outright once TLS moved to an nginx front.
        const raw = await fs.promises.readFile(BROWSE_FIXTURE, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        console.error('Error:', error.message);
        
        if (error.response) {
            console.error('Error Response:', error.response.data);
        } else if (error.request) {
            console.error('No response received:', error.request);
        } else {
            console.error('General error:', error.message);
        }
        
        return { error: 'Failed to read the JSON file' };
    }
}


module.exports = { fetchBrowseData };
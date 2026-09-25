const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const LOG_FILE = path.join(__dirname, 'logs', 'error.log');
const TOKEN_FOLDER = path.join(__dirname, 'token');
const TOKEN_FILE = path.join(TOKEN_FOLDER, 'oauth_token.json');

if (!fs.existsSync(TOKEN_FOLDER)) {
    fs.mkdirSync(TOKEN_FOLDER);
}

const logErrorToFile = (errorMessage) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ERROR: ${errorMessage}\n`;

    if (!fs.existsSync(path.dirname(LOG_FILE))) {
        fs.mkdirSync(path.dirname(LOG_FILE));
    }

    fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
};


async function requestDeviceCode(client_id, scope) {
    try {
        const response = await axios.post('https://oauth2.googleapis.com/device/code', null, {
            params: {
                client_id: client_id,
                scope: scope
            }
        });

        return response.data;
    } catch (error) {
        throw new Error(`Request failed with status code ${error.response ? error.response.status : error.message}`);
    }
}

async function requestToken(client_id, device_code, client_secret, grant_type, refresh_token = null) {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    let params;

    if (grant_type === 'http://oauth.net/grant_type/device/1.0') {
        params = qs.stringify({
            client_id: client_id,
            client_secret: client_secret,
            device_code: device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        });
    } else if (grant_type === 'refresh_token' && refresh_token) {
        params = qs.stringify({
            client_id: client_id,
            client_secret: client_secret,
            refresh_token: refresh_token,
            grant_type: 'refresh_token'
        });
    } else {
        throw new Error('Invalid grant_type or missing refresh_token for refresh grant type.');
    }

    try {
        console.log('Requesting token with the following params:');
        console.log(`client_id: ${client_id}`);
        console.log(`device_code: ${device_code || 'N/A'}`);
        console.log(`client_secret: ${client_secret}`);

        const response = await axios.post(tokenUrl, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.access_token) {
            console.log('Authorization successful, server response:', response.data);
            return response.data;
        }

        if (response.data.error === 'authorization_pending') {
            console.log('Authorization pending. Please complete authorization on another device.');
        } else {
            throw new Error('Unexpected error during token request: ' + response.data.error_description);
        }
    } catch (error) {
        const data = error.response && error.response.data;

        if (data && (data.error === 'authorization_pending' || data.error === 'slow_down')) {
            const e = new Error(`Token not ready yet: ${data.error}`);
            e.passThrough = true;
            e.data = data;
            throw e;
        }

        console.error('Error during token request:', error.message);

        if (error.response) {
            console.error('Error response status:', error.response.status);
            console.error('Error response data:', error.response.data);

            if (error.response.data && error.response.data.error) {
                console.error('Error from server:', error.response.data.error);
                console.error('Error description:', error.response.data.error_description);
            }
        } else {
            console.error('No response from server:', error.message);
        }

        throw new Error(`Error requesting token: ${error.message}`);
    }
}


const revokeToken = async (token) => {
    const revokeUrl = 'https://oauth2.googleapis.com/revoke';
    
    try {
 
        const response = await axios.post(revokeUrl, null, {
            params: {
                token: token,
            }
        });
        
        if (response.status === 200) {
            console.log('Token successfully revoked');
            return { message: 'Token successfully revoked' };
        } else {
            throw new Error(`Failed to revoke token: ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error during token revocation:', error.message);
        throw new Error(`Error during token revocation: ${error.message}`);
    }
};


async function getYouTubeChannelData(accessToken) {
    try {
        const apiUrl = 'https://www.youtube.com/youtubei/v1/guide';

        const postData = {
            context: {
                client: {
                    clientName: 'TVHTML5',
                    clientVersion: '7.20250205.16.00',
                    hl: 'en',
                    gl: 'US',
                }
            }
        };

        const headers = {
            'Content-Type': 'application/json',
        };

        if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
        }

        const response = await axios.post(apiUrl, postData, { headers });

        const guideItems = response.data.items.map(section => section.guideSectionRenderer.items).flat();

        const simulatedResponse = {
            kind: 'youtube#channelListResponse',
            etag: 'etag_value_here',
            items: guideItems.map(item => {
                const guideAccount = item.guideAccountEntryRenderer;
                if (guideAccount && guideAccount.title && guideAccount.thumbnail) {
                    return {
                        kind: 'youtube#channel',
                        id: guideAccount.title.simpleText, 
                        snippet: {
                            title: guideAccount.title.simpleText,
                            description: guideAccount.title.simpleText, 
                            thumbnails: {
                                default: {
                                    url: guideAccount.thumbnail.thumbnails[0].url,
                                },
                            },
                            localized: {
                                title: guideAccount.title.simpleText, 
                                description: guideAccount.title.simpleText,
                            },
                        },
                        statistics: {
                            viewCount: '0', 
                            subscriberCount: '0',
                            videoCount: '0', 
                        },
                    };
                } else {
                    console.warn('Skipping invalid entry:', item);
                    return null;
                }
            }).filter(item => item !== null), 
        };

        return simulatedResponse;
    } catch (error) {
        if (error.response && error.response.status === 401) {
            throw new Error('Unauthorized: Invalid or expired access token.');
        }
        throw new Error(`Error fetching YouTube channel data: ${error.message}`);
    }
}

const oauthRouter = (app) => {

    app.post('/o/oauth2/device/code', async (req, res) => {
        const { client_id, scope } = req.body;

        if (!client_id || !scope) {
            const errorMessage = 'Client ID and scope are required.';
            res.status(400).send(errorMessage);
            logErrorToFile(errorMessage);
            return;
        }

        try {
            const deviceData = await requestDeviceCode(client_id, scope);

            res.json({
                device_code: deviceData.device_code,
                user_code: deviceData.user_code,
                verification_url: deviceData.verification_url,
                expires_in: deviceData.expires_in,
                interval: deviceData.interval
            });
        } catch (error) {
            const errorMessage = `Error during device code request: ${error.message}`;
            res.status(500).send('Error during device code request.');
            logErrorToFile(errorMessage);
        }
    });

    app.post('/o/oauth2/token', async (req, res) => {
        const { client_id, device_code, client_secret, grant_type, refresh_token } = req.body;
    
        if (!client_id || !client_secret || (!device_code && grant_type !== 'refresh_token')) {
            const errorMessage = 'Client ID, client secret, device_code (for device flow), and refresh_token (for refresh flow) are required.';
            res.status(400).send(errorMessage);
            logErrorToFile(errorMessage);
            return;
        }
    
        try {
            const tokenData = await requestToken(client_id, device_code, client_secret, grant_type, refresh_token);
    
            if (tokenData.access_token) {
                const savedData = {
                    access_token: tokenData.access_token,
                    expires_in: tokenData.expires_in,
                    token_type: tokenData.token_type,
                };
    
                if (tokenData.refresh_token) {
                    savedData.refresh_token = tokenData.refresh_token;
                } else if (grant_type === 'refresh_token') {
                    savedData.refresh_token = refresh_token;
                }

                if (!device_code || device_code === 'undefined') {
                    console.warn('Invalid or undefined device code, this dont matter much, since it aint used! It saves because I am lazy to find another way lol.');
                    res.json(tokenData);
                    return;
                }
    
                const deviceTokenFile = path.join(TOKEN_FOLDER, `device_${device_code}_oauth_token.json`);
                fs.writeFileSync(deviceTokenFile, JSON.stringify(savedData, null, 2), 'utf8');
    
                res.json(tokenData);
                
            } else {
                const errorMessage = 'Invalid token response: ' + JSON.stringify(tokenData);
                res.status(400).send(errorMessage);
                logErrorToFile(errorMessage);
            }
        } catch (error) {
            if (error.passThrough) {
                res.status(200).json(error.data);
                return;
            }

            console.error('Error during token request:', error.message);
    
            // Handle specific errors based on response status
            if (error.response) {
                const errorDetails = error.response.data;
                const errorType = errorDetails.error;
                const errorDescription = errorDetails.error_description;
    
                console.error('Error response status:', error.response.status);
                console.error('Error response data:', errorDetails);
    
                if (errorType === 'authorization_pending') {
                    const errorMessage = 'Authorization pending. Please authorize the device.';
                    res.status(428).send(errorMessage);
                    logErrorToFile(`Authorization pending. Waiting for user authorization.`);
                } else if (errorType === 'slow_down') {
                    console.log('Received slow_down error, retrying...');
                    const retryDelay = 2000; // Retry after 2 seconds
                    setTimeout(async () => {
                        try {
                            const retryTokenData = await requestToken(client_id, device_code, client_secret, grant_type, refresh_token);
                            res.json(retryTokenData);
                            fs.writeFileSync(deviceTokenFile, JSON.stringify(retryTokenData, null, 2), 'utf8');
                        } catch (retryError) {
                            const retryErrorMessage = `Retry failed: ${retryError.message}`;
                            res.status(418).send(retryErrorMessage);
                            logErrorToFile(retryErrorMessage);
                        }
                    }, retryDelay);
                } else if (error.response.status === 400) {
                    const errorMessage = `Bad request: ${errorDescription}`;
                    res.status(400).send(errorMessage);
                    logErrorToFile(`Bad request error: ${errorDescription}`);
                } else if (error.response.status === 401) {
                    const errorMessage = 'Unauthorized: Invalid client credentials.';
                    res.status(401).send(errorMessage);
                    logErrorToFile(`Unauthorized error: ${errorDescription}`);
                } else {
                    const errorMessage = `Unexpected error: ${error.message}`;
                    res.status(418).send(errorMessage);
                    logErrorToFile(`Unexpected error: ${errorDescription}`);
                }
            } else {
                const errorMessage = 'Authorization pending. Please authorize the device.';
                res.status(428).send(errorMessage);
                logErrorToFile(`Authorization pending. Waiting for user authorization.`);
            }
        }
    });
    
    
    app.post('/o/oauth2/revoke', async (req, res) => {
        const { token } = req.body;
        
        if (!token) {
            const errorMessage = 'Token is required.';
            res.status(400).send(errorMessage);
            logErrorToFile(errorMessage);
            return;
        }

        try {
    
            const result = await revokeToken(token);``
            res.json(result);
        } catch (error) {
            const errorMessage = `Error during token revocation: ${error.message}`;
            res.status(500).send(errorMessage);
            logErrorToFile(errorMessage);
        }
    });
    
    app.get('/api/youtube/channels', async (req, res) => {
        try {
            const authorizationHeader = req.headers['authorization'];
            const accessToken = authorizationHeader && authorizationHeader.startsWith('Bearer ') ? authorizationHeader.split(' ')[1] : null;
    
            const channelData = await getYouTubeChannelData(accessToken);
            res.json(channelData);
        } catch (error) {
            const errorMessage = `Error fetching YouTube channel data: ${error.message}`;
            console.error(errorMessage);
            res.status(500).send(errorMessage);
        }
    });

    app.get('/user/user_pfp', async (req, res) => {
        try {

            const channelData = await getYouTubeChannelData();
    
            console.log('Fetched YouTube channel data:', JSON.stringify(channelData, null, 2));
    
            function findThumbnailUrl(obj) {
                if (Array.isArray(obj)) {
                    for (let item of obj) {
                        const result = findThumbnailUrl(item);
                        if (result) {
                            return result;  
                        }
                    }
                } else if (typeof obj === 'object' && obj !== null) {
                    for (let key in obj) {
                        if (obj.hasOwnProperty(key)) {
                            if (key === 'url' && obj[key]) {
                                return obj[key];  
                            }
                            const result = findThumbnailUrl(obj[key]);
                            if (result) {
                                return result;  
                            }
                        }
                    }
                }
                return null;  
            }

            const profilePictureUrl = findThumbnailUrl(channelData);
    
            if (profilePictureUrl) {
                axios.get(profilePictureUrl, { responseType: 'arraybuffer' })
                    .then(response => {
                        res.set('Content-Type', 'image/jpeg');
                        res.send(response.data); 
                    })
                    .catch(err => {
                        res.status(500).json({ error: 'Error fetching the profile picture image.' });
                    });
            } else {
                res.status(404).json({ error: 'Profile picture not found' });
            }
        } catch (error) {
            const errorMessage = `Error fetching YouTube channel data for profile picture: ${error.message}`;
            console.error(errorMessage);
            res.status(500).send(errorMessage);
        }
    });
    
    
    

    

};

module.exports = oauthRouter;

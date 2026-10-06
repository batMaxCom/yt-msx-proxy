const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const logger = require('./logger');
const viewerAccounts = require('./viewer_accounts');

const LOG_FILE = path.join(__dirname, 'logs', 'error.log');
// back/token/ is no longer written to: tokens belong to the viewer account that
// /o/oauth2/token now adopts, and they live in back/accounts/<sub>.json.

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

/* A device code is a credential, not an identifier: anyone holding it can trade
   it for tokens. Logs need to tie a polling sequence together, so they get a
   stable short fingerprint instead of the value. */
function secretFingerprint(value) {
    if (!value) return null;
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
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
        // Never log the client secret or a device code: both are credentials, and
        // the token response carries the access and refresh tokens verbatim.
        logger.info('oauth', 'TOKEN_REQUEST', {
            client_id,
            grant_type,
            device_code_fp: secretFingerprint(device_code),
        });

        const response = await axios.post(tokenUrl, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        if (response.data.access_token) {
            logger.info('oauth', 'TOKEN_ISSUED', {
                client_id,
                grant_type,
                device_code_fp: secretFingerprint(device_code),
                token_type: response.data.token_type || null,
                expires_in: Number(response.data.expires_in) || 0,
                has_refresh_token: !!response.data.refresh_token,
            });
            return response.data;
        }

        if (response.data.error === 'authorization_pending') {
            logger.info('oauth', 'TOKEN_PENDING', {
                device_code_fp: secretFingerprint(device_code),
            });
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

    /*
     * The 2016 bundle asks for its device code here, from the client id and scope
     * hardcoded in its own minified source, and then shows the code in the native
     * "Sign in to this TV" dialog. Both requests the bundle makes are relative, so
     * they land on this server and nowhere else - which means the dialog can be
     * kept as the only sign-in UI while the grant behind it becomes ours.
     *
     * That is what the next block does: the code is requested for our client, not
     * the bundle's. The dialog is unchanged - the same text box, the same code
     * length, the same verification_url contract - but approving it signs the
     * viewer in as a person, which is what /o/oauth2/token then needs to store.
     *
     * The bundle's own client_id and scope are ignored, deliberately. Honouring them
     * would mean a second grant again: playback as one identity, the journal as
     * another, on one set. If our client is not configured the request falls
     * through to the legacy pair so a TV with no viewer OAuth still plays rather
     * than presenting a sign-in that cannot succeed.
     */
    app.post('/o/oauth2/device/code', async (req, res) => {
        const cfg = viewerAccounts.loadConfig();

        if (cfg.ready) {
            try {
                const pending = await viewerAccounts.startSignIn();
                logger.info('oauth', 'DEVICE_CODE_ISSUED', {
                    client_id: cfg.clientId,
                    scope: cfg.scope,
                    expires_in: Math.round((pending.expiresAt - Date.now()) / 1000),
                });
                res.json({
                    device_code: pending.deviceCode,
                    user_code: pending.userCode,
                    verification_url: pending.verificationUrl,
                    expires_in: Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)),
                    interval: pending.interval,
                });
            } catch (error) {
                const message = `Error during device code request: ${error.message}`;
                logger.warn('oauth', 'device code request failed', {
                    reason: logger.truncateStderr(String(error.message || error)),
                });
                res.status(500).send('Error during device code request.');
                logErrorToFile(message);
            }
            return;
        }

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

    /*
     * Step 2 of the native sign-in, and the point where the account becomes real.
     *
     * The device_code in here belongs to whichever client /o/oauth2/device/code
     * asked for it - our client, because that route now prefers it - so the
     * exchange below uses our credentials and the bundle's client_secret in the
     * body is discarded. Google rejects a device_code presented with the wrong
     * client_id, so mixing the two would fail on the first poll.
     *
     * On success the token is adopted: identified against userinfo, cached, and its
     * refresh token stored in back/accounts/<sub>.json. The session cookie is set
     * here, on this response, so the very next request from the same browser is
     * already signed in - the bundle does nothing to help with that, it only keeps
     * the bearer in its own localStorage.
     *
     * Writing back/token/ is gone. That file existed for the old arrangement, where
     * token_store.js hunted for it; token_store.js now reads the account this route
     * creates, so a second copy of the same token on disk would only be a second
     * thing to expire unnoticed.
     *
     * The 428/slow_down grammar below is untouched, and it is the only reason this
     * route can be the poll loop: the bundle polls here itself, on a timer, until
     * Google stops saying authorization_pending.
     */
    app.post('/o/oauth2/token', async (req, res) => {
        const { device_code, grant_type, refresh_token } = req.body;
        const isRefresh = grant_type === 'refresh_token';
        const cfg = viewerAccounts.loadConfig();

        if (!device_code && !isRefresh) {
            const errorMessage = 'Client ID, client secret, device_code (for device flow), and refresh_token (for refresh flow) are required.';
            res.status(400).send(errorMessage);
            logErrorToFile(errorMessage);
            return;
        }

        try {
            const tokenData = cfg.ready
                ? await requestToken(cfg.clientId, device_code, cfg.clientSecret, grant_type, refresh_token)
                : await requestToken(req.body.client_id, device_code, req.body.client_secret, grant_type, refresh_token);

            if (tokenData.access_token) {
                if (!isRefresh && device_code && device_code !== 'undefined') {
                    let identity = null;
                    try {
                        identity = await viewerAccounts.adoptExchangedToken(tokenData);
                    } catch (error) {
                        // Playback does not depend on knowing who this is: the
                        // bundle walks away with a usable bearer either way, and
                        // whoami will report the account as signed out rather than
                        // reporting a broken sign-in.
                        logger.warn('oauth', 'token issued, account not adopted', {
                            device_code_fp: secretFingerprint(device_code),
                            reason: logger.truncateStderr(String(error.message || error)),
                        });
                    }
                    if (identity) {
                        res.setHeader('Set-Cookie', viewerAccounts.sessionCookie(
                            viewerAccounts.signSession(identity.sub, Date.now())));
                        logger.info('oauth', 'viewer session issued', { sub: identity.sub });
                    }
                }

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
                    // Google is asking for a longer gap between polls, and this
                    // branch used to answer by trying once more on a fixed two
                    // second timer - which is slower than what it just asked for,
                    // so it drew slow_down again and answered with 418. The bundle
                    // is already pacing itself; the honest thing is to say so and
                    // let it poll again, rather than guess a delay here and hold
                    // the response open while guessing.
                    logger.info('oauth', 'slow_down', {
                        device_code_fp: secretFingerprint(device_code),
                    });
                    res.status(429).json({
                        error: 'slow_down',
                        interval: Number(errorDetails.interval) || 10,
                    });
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

        /*
         * This is the bundle's sign-out, and it is the only sign-out that is not
         * ours. Its Settings menu clears the bearer it kept in memory and the
         * tv-refresh-token it stored, then posts the token here - it never calls
         * /api/*, and yt_sess is HttpOnly, so from its point of view the viewer
         * session does not exist. Left alone that means signing out on the set
         * ends the client but not the account: history keeps recording under the
         * sub in the cookie, and the History tab keeps showing it, because from
         * the server's side nobody ever left.
         *
         * So end that session here, before the token is handed back to Google.
         * Local-only: the grant survives a client-side sign-out, so signing back in
         * does not need a fresh device flow. Revoking the grant stays behind
         * /api/auth/logout.
         */
        try {
            const sub = viewerAccounts.endSessionFromCookieHeader(
                req.headers && req.headers.cookie);
            if (sub) {
                res.setHeader('Set-Cookie', viewerAccounts.clearedSessionCookie());
                logger.info('auth', 'viewer session ended by bundle sign out', { sub });
            }
        } catch (error) {
            logger.warn('auth', 'bundle sign out could not end viewer session', {
                reason: logger.truncateStderr(String(error.message || error)),
            });
        }

        try {
    
            const result = await revokeToken(token);
            res.json(result);
        } catch (error) {
            /*
             * Google refusing the token is not a failed sign-out. The viewer
             * session is already ended above and the bundle drops its copy of the
             * token whatever the answer says, so a 500 here only makes the client
             * treat a completed sign-out as a broken one. Report it and answer
             * normally - the sign-out is the outcome, not Google's opinion of it.
             */
            logger.warn('auth', 'google revoke failed, sign out still completed', {
                reason: logger.truncateStderr(String(error.message || error)),
            });
            res.json({ message: 'Token revocation reported an error; local sign out completed.' });
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

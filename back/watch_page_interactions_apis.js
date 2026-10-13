const fs = require('fs');
const axios = require('axios');
const path = require('path');

const viewerAccounts = require('./viewer_accounts');
const subscriptionsFeed = require('./subscriptions_feed');
const logger = require('./logger');

function cookieValue(req, name) {
    const raw = req.headers && req.headers.cookie;
    if (!raw || typeof raw !== 'string') return '';
    const needle = name + '=';
    for (const part of String(raw).split(';')) {
        const t = part.trim();
        if (t.indexOf(needle) === 0) {
            try { return decodeURIComponent(t.slice(needle.length)); } catch (e) { return t.slice(needle.length); }
        }
    }
    return '';
}

/*
 * The bearer to act as, in priority order:
 *
 *   1. the Authorization header - a client that still holds a legacy token;
 *   2. the signed-in account's token from the yt_sess session cookie.
 *
 * With the custom device-flow sign-in the 2016 bundle holds no token of its own
 * (the session is an HttpOnly cookie), so /api/like and /api/subscription used
 * to answer "access token not found" for every real viewer. Resolving the
 * session token here is what makes the Subscribe and Like controls work at all.
 */
async function resolveAccessToken(req) {
    const header = req.headers['authorization'];
    if (header && header.indexOf('Bearer ') === 0) {
        const token = header.slice(7).trim();
        if (token) return token;
    }
    const sub = viewerAccounts.verifySession(cookieValue(req, viewerAccounts.SESSION_COOKIE));
    if (sub) {
        try {
            const token = await viewerAccounts.accessTokenFor(sub);
            if (token) return token;
        } catch (err) {
            logger.warn('interactions', 'session token unavailable', {
                sub,
                message: logger.truncateStderr(String(err.message || err)),
            });
        }
    }
    return null;
}

async function handleLikeAction(req, res) {
    const { action } = req.params;
    const { videoId } = req.body.target;

    if (!videoId || typeof videoId !== 'string' || !videoId.trim()) {
        return res.status(400).json({
            error: 'Video ID is required and must be a non-empty string.'
        });
    }

    if (!['like', 'removelike', 'dislike'].includes(action)) {
        return res.status(400).json({
            error: 'Invalid action. Valid actions are "like", "removelike", and "dislike".'
        });
    }

    try {
        const accessToken = await resolveAccessToken(req);
        if (!accessToken) {
            return res.status(401).json({ error: 'Sign in to rate videos.', signed_in: false });
        }

        let apiUrl = '';
        switch (action) {
            case 'like':
                apiUrl = 'https://www.youtube.com/youtubei/v1/like/like';
                break;
            case 'removelike':
                apiUrl = 'https://www.youtube.com/youtubei/v1/like/removelike';
                break;
            case 'dislike':
                apiUrl = 'https://www.youtube.com/youtubei/v1/like/dislike';
                break;
        }

        const requestBody = {
            context: {
                client: {
                    clientName: "TVHTML5",
                    clientVersion: "5.20150715",
                    screenWidthPoints: 1632,
                    screenHeightPoints: 904,
                    screenPixelDensity: 1,
                    theme: "CLASSIC",
                    webpSupport: false,
                    acceptRegion: "US",
                    acceptLanguage: "en-US"
                },
                user: {
                    enableSafetyMode: false
                }
            },
            target: {
                videoId
            }
        };

        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json({
            message: `Successfully ${action}d the video.`,
            data: response.data
        });
    } catch (error) {
        console.error('Error performing like action:', error.message);
        res.status(500).json({
            error: 'Failed to perform the like action.',
            details: error.message || 'No additional details available.'
        });
    }
}

async function handleSubscriptionAction(req, res) {
    const { action } = req.params;
    const { channelIds } = req.body;

    if (!Array.isArray(channelIds) || channelIds.length === 0 || !channelIds[0]) {
        return res.status(400).json({
            error: 'Channel IDs are required and must be a non-empty array.'
        });
    }

    if (!['subscribe', 'unsubscribe'].includes(action)) {
        return res.status(400).json({
            error: 'Invalid action. Valid actions are "subscribe" and "unsubscribe".'
        });
    }

    try {
        const accessToken = await resolveAccessToken(req);
        if (!accessToken) {
            return res.status(401).json({ error: 'Sign in to subscribe.', signed_in: false });
        }

        let apiUrl = '';
        switch (action) {
            case 'subscribe':
                apiUrl = 'https://www.youtube.com/youtubei/v1/subscription/subscribe';
                break;
            case 'unsubscribe':
                apiUrl = 'https://www.youtube.com/youtubei/v1/subscription/unsubscribe';
                break;
        }

        const requestBody = {
            context: {
                client: {
                    clientName: "TVHTML5",
                    clientVersion: "5.20150715",
                    screenWidthPoints: 1632,
                    screenHeightPoints: 904,
                    screenPixelDensity: 1,
                    theme: "CLASSIC",
                    webpSupport: false,
                    acceptRegion: "US",
                    acceptLanguage: "en-US"
                },
                user: {
                    enableSafetyMode: false
                }
            },
            target: {
                channelIds
            }
        };

        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        res.status(200).json({
            message: `Successfully ${action}d the channel.`,
            data: response.data
        });
    } catch (error) {
        console.error('Error performing subscription action:', error.message);
        res.status(500).json({
            error: 'Failed to perform the subscription action.',
            details: error.message || 'No additional details available.'
        });
    }
}

/*
 * Subscription state for one channel, so a Subscribe control can render the
 * right label on load instead of after the first click. Signed out is a normal
 * answer, not an error: the client uses it to disable the button.
 */
async function handleSubscriptionStatus(req, res) {
    const channelId = String((req.query && req.query.channelId) || '').trim();
    if (!/^UC[\w-]{22}$/.test(channelId)) {
        return res.status(400).json({ error: 'A valid channelId is required.' });
    }
    const accessToken = await resolveAccessToken(req);
    if (!accessToken) {
        return res.json({ signed_in: false, subscribed: false });
    }
    try {
        const subscribed = await subscriptionsFeed.isSubscribed(accessToken, channelId);
        res.json({ signed_in: true, subscribed: !!subscribed });
    } catch (err) {
        logger.warn('interactions', 'subscription status lookup failed', {
            channel_id: channelId,
            message: logger.truncateStderr(String(err.message || err)),
        });
        res.status(500).json({ signed_in: true, error: 'status lookup failed' });
    }
}

module.exports = function(app) {
    app.post('/api/like/:action', handleLikeAction);
    app.get('/api/subscription/status', handleSubscriptionStatus);
    app.post('/api/subscription/:action', handleSubscriptionAction);
};

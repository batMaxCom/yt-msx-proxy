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
    const { videoId } = (req.body && req.body.target) || {};

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

    /*
     * Data API, not InnerTube. The InnerTube like/like endpoint answers 200 for
     * the TVHTML5 client but does not change the rating (verified: getRating
     * stays "none"), the same silent no-op as subscription/subscribe.
     * videos.rate uses the same OAuth token and actually rates the video.
     */
    const rating = action === 'removelike' ? 'none' : action;
    try {
        const accessToken = await resolveAccessToken(req);
        if (!accessToken) {
            return res.status(401).json({ error: 'Sign in to rate videos.', signed_in: false });
        }

        await axios.post('https://www.googleapis.com/youtube/v3/videos/rate', null, {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { id: videoId, rating },
            timeout: 20000,
        });

        res.status(200).json({
            message: `Successfully ${action}d the video.`,
            rating,
        });
    } catch (error) {
        logger.warn('interactions', 'like action failed', {
            action,
            video_id: videoId,
            status: (error.response && error.response.status) || 0,
            message: logger.truncateStderr(String(error.message || error)),
        });
        res.status(500).json({ error: 'Failed to perform the like action.' });
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

    /*
     * Data API, not InnerTube. The InnerTube subscription/subscribe endpoint
     * answers 200 for the TVHTML5 client this app carries but silently does
     * nothing (no actions in the response, no subscription on the account) -
     * the button showed its optimistic tick and stayed wrong. subscriptions
     * .insert/delete uses the same OAuth token and really changes the account.
     */
    const channelId = String(channelIds[0]);
    try {
        const accessToken = await resolveAccessToken(req);
        if (!accessToken) {
            return res.status(401).json({ error: 'Sign in to subscribe.', signed_in: false });
        }

        if (action === 'subscribe') {
            await subscriptionsFeed.subscribe(accessToken, channelId);
            return res.status(200).json({ message: 'Successfully subscribed the channel.', subscribed: true });
        }

        const result = await subscriptionsFeed.unsubscribe(accessToken, channelId);
        return res.status(200).json({
            message: 'Successfully unsubscribed the channel.',
            subscribed: false,
            deleted: !!result.deleted,
        });
    } catch (error) {
        const status = (error.response && error.response.status) || 0;
        // 409 means the subscription already exists - not a failure to the user.
        if (action === 'subscribe' && status === 409) {
            return res.status(200).json({ message: 'Already subscribed.', subscribed: true });
        }
        logger.warn('interactions', 'subscription action failed', {
            action,
            channel_id: channelId,
            status,
            message: logger.truncateStderr(String(error.message || error)),
        });
        res.status(500).json({ error: 'Failed to perform the subscription action.' });
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

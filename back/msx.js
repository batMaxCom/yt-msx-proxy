/**
 * Media Station X (MSX) integration.
 *
 * Spec references:
 * - Start Object: https://msx.benzac.de/wiki/index.php?title=Start_Object
 * - Menu Root Object: https://msx.benzac.de/wiki/index.php?title=Menu_Root_Object
 * - Content Root Object / Items: https://msx.benzac.de/wiki/index.php?title=Content_Item_Object
 * - Actions (link:): https://msx.benzac.de/wiki/index.php?title=Actions
 * - External HTML5 apps: Tips & Tricks → External HTML5 Games/Apps
 *
 * Launch mode: combined (Variant C)
 *   MSX → /msx/start.json → menu.json → link:{APP} → 2016YouTubeTV web UI
 */

function getBaseUrl(req, serverIp, port) {
    const hostHeader = req.get('host');
    if (hostHeader) {
        const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
        return `${proto}://${hostHeader}`;
    }
    return `http://${serverIp}:${port}`;
}

function sendMsxJson(res, payload) {
    res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
    });
    res.status(200).json(payload);
}

function buildStartObject() {
    // {PREFIX}/{SERVER} are replaced by MSX only inside start.json parameter
    return {
        name: '2016 YouTube TV',
        version: '1.0.0',
        parameter: 'menu:{PREFIX}{SERVER}/msx/menu.json',
        welcome: 'none',
        launcher: {
            name: '2016 YouTube TV',
            icon: 'smart-display',
            image: 'none',
            color: '#e62d27'
        }
    };
}

function buildMenuObject(baseUrl) {
    const appUrl = `${baseUrl}/?msx=1`;
    return {
        name: '2016 YouTube TV',
        version: '1.0.0',
        headline: '2016 YouTube TV',
        // Start Action: open the full web app immediately on first launch.
        // Skipped when returning from a link action (MSX restores menu).
        action: `link:${appUrl}`,
        menu: [
            {
                icon: 'smart-display',
                label: 'YouTube TV',
                extensionLabel: 'Open',
                data: `${baseUrl}/msx/home.json`
            },
            {
                icon: 'info',
                label: 'About',
                data: `${baseUrl}/msx/about.json`
            }
        ]
    };
}

function buildHomeObject(baseUrl) {
    const appUrl = `${baseUrl}/?msx=1`;
    return {
        type: 'pages',
        headline: '2016 YouTube TV',
        background: `${baseUrl}/assets/default_bg.jpg`,
        template: {
            type: 'separate',
            layout: '0,0,6,3',
            icon: 'msx-white-soft:smart-display',
            color: 'msx-glass'
        },
        items: [
            {
                focus: true,
                title: 'Open YouTube TV',
                titleFooter: 'Search · Watch · Play',
                action: `link:${appUrl}`
            },
            {
                title: 'About',
                titleFooter: 'Integration info',
                action: `content:${baseUrl}/msx/about.json`
            }
        ]
    };
}

function buildAboutObject(baseUrl) {
    return {
        type: 'pages',
        headline: 'About',
        template: {
            type: 'separate',
            layout: '0,0,12,6',
            color: 'msx-glass'
        },
        items: [
            {
                type: 'space',
                layout: '0,0,12,6',
                text: [
                    '{txt:msx-white:2016 YouTube TV}',
                    '',
                    'Legacy YouTube TV (2015–2016) web client.',
                    `Backend: ${baseUrl}`,
                    '',
                    'MSX opens this app with the link: action.',
                    'If Validate Links blocks launch, disable it in',
                    'MSX Settings → Validate Links.',
                    '',
                    'Press Back / use Exit to MSX inside the app',
                    'to return here.'
                ].join('\n'),
                action: `link:${baseUrl}/?msx=1`
            }
        ]
    };
}

function registerMsxRoutes(app, { serverIp, port }) {
    app.get('/msx/start.json', (req, res) => {
        sendMsxJson(res, buildStartObject());
    });

    app.get('/msx/menu.json', (req, res) => {
        const baseUrl = getBaseUrl(req, serverIp, port);
        sendMsxJson(res, buildMenuObject(baseUrl));
    });

    app.get('/msx/home.json', (req, res) => {
        const baseUrl = getBaseUrl(req, serverIp, port);
        sendMsxJson(res, buildHomeObject(baseUrl));
    });

    app.get('/msx/about.json', (req, res) => {
        const baseUrl = getBaseUrl(req, serverIp, port);
        sendMsxJson(res, buildAboutObject(baseUrl));
    });

    // Convenience: /msx → start object
    app.get(['/msx', '/msx/'], (req, res) => {
        res.redirect(302, '/msx/start.json');
    });
}

function isMsxPath(pathname) {
    return pathname === '/msx' || pathname.indexOf('/msx/') === 0;
}

module.exports = {
    registerMsxRoutes,
    isMsxPath,
    getBaseUrl
};

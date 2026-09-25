const fs = require('fs');
const path = require('path');
const axios = require('axios');

function guideTitleText(formattedTitle) {
    if (!formattedTitle) return '';
    if (Array.isArray(formattedTitle.runs)) return formattedTitle.runs.map(r => r.text || '').join('');
    if (formattedTitle.simpleText) return formattedTitle.simpleText;
    return '';
}

function replaceBrowseId(obj) {
    if (Array.isArray(obj)) {
        obj.forEach(item => replaceBrowseId(item)); 
    } else if (typeof obj === 'object' && obj !== null) {
        Object.keys(obj).forEach(key => {
            if (key === 'browseId' && obj[key] === 'FEtopics') {
                obj[key] = 'home'; 
            } else {
                replaceBrowseId(obj[key]); 
            }
        });
    }
}

async function fetchGuideData(authToken = null) {

    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir); 
    }

    const filePath = path.join(__dirname, '..', 'assets', 'guide_json.json');
    const apiUrl = 'https://www.googleapis.com/youtubei/v1/guide';
    const apiKey = 'AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8';


    if (!authToken) {
        try {
            const rawData = fs.readFileSync(filePath, 'utf-8');
            let guideData = JSON.parse(rawData);
            console.log('Using fixed guide data:', JSON.stringify(guideData, null, 2));
            return guideData;
        } catch (error) {
            console.error('Error reading fixed guide data:', error.message);
            throw new Error('Failed to read guide data.');
        }
    }

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

    
    try {
        console.log('Sending request to YouTube Guide API with payload:', postData);

        const response = await axios.post(apiUrl, postData, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            params: { key: apiKey }
        });

        // We gotta clean the data!

        console.log('Direct response from YouTube Guide API:', response.data);
        
        if (response.data && Array.isArray(response.data.items)) {
            response.data.items.forEach(section => {
                if (section.guideSectionRenderer && Array.isArray(section.guideSectionRenderer.items)) {
                    section.guideSectionRenderer.items = section.guideSectionRenderer.items.filter(item => {
                        return !(item.guideEntryRenderer &&
                            guideTitleText(item.guideEntryRenderer.formattedTitle) === "More");
                    });

                    /*
                    const uploadItem = {
                        "guideEntryRenderer": {
                            "navigationEndpoint": {
                                "clickTrackingParams": "CAIQtSwYACITCLSowKe7jIsDFZDMFgkdakQqlg==",
                                "uploadEndpoint": {
                                    "hack": false
                                }
                            },
                            "icon": {
                                "iconType": "UPLOADS"
                            },
                            "trackingParams": "CAIQtSwYACITCLSowKe7jIsDFZDMFgkdakQqlg==",
                            "formattedTitle": {
                                "runs": [
                                    {
                                        "text": "Upload"
                                    }
                                ]
                            }
                        }
                    };
                    */

                    const settingsItem = {
                        "guideEntryRenderer": {
                            "navigationEndpoint": {
                                "clickTrackingParams": "CAIQtSwYACITCLSowKe7jIsDFZDMFgkdakQqlg==",
                                "applicationSettingsEndpoint": {
                                    "hack": false
                                }
                            },
                            "icon": {
                                "iconType": "SETTINGS"
                            },
                            "trackingParams": "CAIQtSwYACITCLSowKe7jIsDFZDMFgkdakQqlg==",
                            "formattedTitle": {
                                "runs": [
                                    {
                                        "text": "Settings"
                                    }
                                ]
                            }
                        }
                    };

                    /*
         
                    if (!section.guideSectionRenderer.items.some(item => item.guideEntryRenderer && 
                        item.guideEntryRenderer.formattedTitle.runs.some(run => run.text === "Upload"))) {
                        section.guideSectionRenderer.items.push(uploadItem);
                    }

                    */

                    if (!section.guideSectionRenderer.items.some(item => item.guideEntryRenderer &&
                        guideTitleText(item.guideEntryRenderer.formattedTitle) === "Settings")) {
                        section.guideSectionRenderer.items.push(settingsItem);
                    }

                    

                    section.guideSectionRenderer.items.forEach(item => {

                        if (item.guideEntryRenderer) {
                            const ft = item.guideEntryRenderer.formattedTitle;
                            if (ft && typeof ft.simpleText === 'string' && !Array.isArray(ft.runs)) {
                                item.guideEntryRenderer.formattedTitle = { runs: [{ text: ft.simpleText }] };
                            }
                        }

                        if (item.guideEntryRenderer && !item.guideEntryRenderer.icon) {
                            item.guideEntryRenderer.icon = {
                                "iconType": "WHAT_TO_WATCH"
                            };
                        }

                        if (item.guideEntryRenderer && item.guideEntryRenderer.formattedTitle && item.guideEntryRenderer.formattedTitle.runs[0]) {
                            const titleText = item.guideEntryRenderer.formattedTitle.runs[0].text;
                    
                            if (titleText === "Gaming") {
                                item.guideEntryRenderer.icon.iconType = "GAMING";
                            } else if (titleText === "Movies & TV") {
                                item.guideEntryRenderer.icon.iconType = "FILM";
                            } else if (titleText === "Music") {
                                item.guideEntryRenderer.icon.iconType = "MUSIC";
                            }
                        }

                        if (item.guideEntryRenderer && item.guideEntryRenderer.icon && item.guideEntryRenderer.icon.iconType === "TAB_LIBRARY") {
                            item.guideEntryRenderer.icon.iconType = "WATCH_HISTORY";
                            if (item.guideEntryRenderer.formattedTitle && item.guideEntryRenderer.formattedTitle.runs && item.guideEntryRenderer.formattedTitle.runs[0]) {
                                item.guideEntryRenderer.formattedTitle.runs[0].text = "History";
                            }
                        }
                    });

                }
            });
        }

        replaceBrowseId(response.data);

        const timestamp = Math.floor(Date.now() / 1000);
        const logFilePath = path.join(logsDir, `guide_response_${timestamp}.json`);
        fs.writeFileSync(logFilePath, JSON.stringify(response.data, null, 2), 'utf-8');

        return response.data;
    } catch (error) {
        console.error('Error fetching guide data:', error.message);

        try {
            const rawData = fs.readFileSync(filePath, 'utf-8');
            const guideData = JSON.parse(rawData);
            console.log('Guide API failed, falling back to fixed guide data.');
            return guideData;
        } catch (fallbackError) {
            console.error('Error reading fixed guide data:', fallbackError.message);
            throw new Error('Failed to fetch data from YouTube Guide API.');
        }
    }
}

module.exports = { fetchGuideData };

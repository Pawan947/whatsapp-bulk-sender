// [The JavaScript content remains unchanged from your original code]
document.addEventListener('DOMContentLoaded', () => {
    if (!window.electronAPI) {
        console.error('electronAPI is not defined. Check preload.js and main.js configuration.');
        document.getElementById('authStatus').textContent = 'Error: electronAPI not loaded';
        return;
    }
    
    const socket = io('http://localhost:3000');
    const tabs = document.querySelectorAll(".tab-btn");
    const contents = document.querySelectorAll(".tab-content");
    const qrCanvas = document.getElementById("qrCanvas");
    const qrStatus = document.getElementById("qrStatus");
    const sendLog = document.getElementById("sendLog");
    const sendBulkBtn = document.getElementById("sendBulkBtn");
    const pauseBulkBtn = document.getElementById("pauseBulkBtn");
    const authStatus = document.getElementById("authStatus");

    let isSending = false;
    let geminiResponse = "";
    let messages = [];
    let pollVotes = {};
    let settings = JSON.parse(localStorage.getItem("bulkSettings")) || {
        dailyLimit: 500, batchSize: 50, batchGap: 1, minMessageDelay: 30, maxMessageDelay: 120, nonPeakStart: 2, nonPeakEnd: 5
    };
    let isAuthenticated = false;
    let token = localStorage.getItem("sessionToken") || null;

    function updateTabVisibility() {
        tabs.forEach(tab => {
            const tabName = tab.dataset.tab;
            if (tabName === "auth" || tabName === "qr") {
                tab.style.display = "block";
            } else {
                tab.style.display = isAuthenticated ? "block" : "none";
            }
        });

        if (!isAuthenticated) {
            tabs.forEach(t => t.classList.remove("active"));
            contents.forEach(c => c.classList.remove("active"));
            document.querySelector(".tab-btn[data-tab='auth']").classList.add("active");
            document.getElementById("auth").classList.add("active");
        }
    }

    function generateQrCodeUrl(qrData) {
        if (!qrData) {
            console.error("No QR code data provided");
            qrStatus.textContent = "Error: No QR code data received";
            return null;
        }
        try {
            const encodedData = encodeURIComponent(qrData);
            const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodedData}`;
            console.log("Generated QR code URL:", qrCodeUrl);
            return qrCodeUrl;
        } catch (error) {
            console.error("Error generating QR code URL:", error);
            qrStatus.textContent = "Error: Failed to generate QR code URL";
            return null;
        }
    }

    function displayQrCode(qrData) {
        const qrCodeUrl = generateQrCodeUrl(qrData);
        if (!qrCodeUrl) return;
        try {
            qrCanvas.innerHTML = "";
            const img = document.createElement("img");
            img.src = qrCodeUrl;
            img.alt = "QR Code";
            img.onerror = () => {
                console.error("Failed to load QR code image");
                qrStatus.textContent = "Error: Failed to load QR code image";
            };
            img.onload = () => {
                console.log("QR code image loaded successfully");
            };
            qrCanvas.appendChild(img);
        } catch (error) {
            console.error("Error displaying QR code image:", error);
            qrStatus.textContent = "Error: Failed to display QR code";
        }
    }

    function loadSettings() {
        document.getElementById("dailyLimit").value = settings.dailyLimit;
        document.getElementById("batchSize").value = settings.batchSize;
        document.getElementById("batchGap").value = settings.batchGap;
        document.getElementById("minMessageDelay").value = settings.minMessageDelay;
        document.getElementById("maxMessageDelay").value = settings.maxMessageDelay;
        document.getElementById("nonPeakStart").value = settings.nonPeakStart;
        document.getElementById("nonPeakEnd").value = settings.nonPeakEnd;
    }

    function saveSettings() {
        settings = {
            dailyLimit: parseInt(document.getElementById("dailyLimit").value),
            batchSize: Math.min(Math.max(parseInt(document.getElementById("batchSize").value), 50), 100),
            batchGap: parseFloat(document.getElementById("batchGap").value) * 60 * 60 * 1000,
            minMessageDelay: parseInt(document.getElementById("minMessageDelay").value) * 1000,
            maxMessageDelay: parseInt(document.getElementById("maxMessageDelay").value) * 1000,
            nonPeakStart: parseInt(document.getElementById("nonPeakStart").value),
            nonPeakEnd: parseInt(document.getElementById("nonPeakEnd").value)
        };
        localStorage.setItem("bulkSettings", JSON.stringify(settings));
        alert("Settings saved!");
    }

    async function generateDullText(text) {
        if (!isAuthenticated) {
            alert("Please authenticate first");
            return null;
        }
        const prompt = "Generate a short, less engaging version of: " + text;
        try {
            const { response } = await window.electronAPI.generateResponse({ token, prompt });
            geminiResponse = response;
            return response;
        } catch (error) {
            console.error("Error generating dull text:", error);
            return "failed: " + text;
        }
    }

    async function generateAndSetDullText() {
        const result = await generateDullText(document.getElementById("bulkMessage").value);
        if (result) document.getElementById("bulkMessage").value = result;
    }

    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            if (tab.dataset.tab !== "auth" && tab.dataset.tab !== "qr" && !isAuthenticated) {
                alert("Please authenticate first");
                return;
            }
            tabs.forEach(t => t.classList.remove("active"));
            contents.forEach(c => c.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.tab).classList.add("active");
            if (tab.dataset.tab === "qr") fetchQrStatus();
            if (tab.dataset.tab === "messages" && isAuthenticated) updateMessages();
            if (tab.dataset.tab === "polls" && isAuthenticated) updatePolls();
            if (tab.dataset.tab === "settings") loadSettings();
        });
    });

    socket.on("connect", () => {
        fetchQrStatus();
        updateTabVisibility();
    });

    socket.on("qrUpdate", qr => {
        console.log("Received QR code data:", qr);
        qrStatus.textContent = "Scan QR Code to Connect";
        displayQrCode(qr);
    });

    socket.on("authSuccess" && isAuthenticated, () => {
        qrCanvas.innerHTML = "";
        qrStatus.textContent = "Connected Successfully!";
        
        updateTabVisibility();
        updateMessages();
        updatePolls();
    });

    socket.on("connection complete", () => {
        qrStatus.textContent = "WhatsApp Client Ready";
    });

    socket.on("clientDisconnected", reason => {
        qrCanvas.innerHTML = "";
        qrStatus.textContent = "Disconnected: " + reason + ". Reconnecting...";
        isAuthenticated = false;
        updateTabVisibility();
        fetchQrStatus();
    });

    socket.on("newMessage", newMessages => {
        messages = newMessages;
        updateMessages();
    });

    socket.on("pollUpdate", ({ pollId, votes }) => {
        pollVotes[pollId] = votes;
        updatePolls();
    });

    socket.on("init", ({ messages: initMessages, polls, pollVotes: initPollVotes, authenticated, qr }) => {
        messages = initMessages || [];
        pollVotes = initPollVotes || {};
        isAuthenticated = authenticated;
        updateTabVisibility();
        if (isAuthenticated) {
            updateMessages();
            updatePolls(polls, pollVotes);
            qrStatus.textContent = "Connected Successfully!";
            qrCanvas.innerHTML = "";
        } else if (qr) {
            console.log("Initial QR code data:", qr);
            qrStatus.textContent = "Scan QR Code to Connect";
            displayQrCode(qr);
        } else {
            qrStatus.textContent = "Waiting for QR Code...";
        }
    });

    socket.on("bulkStart", ({ total, current }) => {
        isSending = true;
        sendLog.innerHTML = `<div class="log-entry">Starting bulk send to ${total} numbers...</div>`;
        sendBulkBtn.style.display = "none";
        pauseBulkBtn.style.display = "block";
        document.getElementById("bulkProgress").style.width = (current / total * 100) + "%";
    });

    socket.on("bulkProgress", ({ number, status, current, total }) => {
        sendLog.innerHTML += `<div class="log-entry">${number}: ${status} (${current}/${total})</div>`;
        sendLog.scrollTop = sendLog.scrollHeight;
        document.getElementById("bulkProgress").style.width = (current / total * 100) + "%";
    });

    socket.on("bulkPaused", ({ current, total }) => {
        isSending = false;
        sendLog.innerHTML += `<div class="log-entry">Paused at ${current}/${total}</div>`;
        sendBulkBtn.style.display = "block";
        pauseBulkBtn.style.display = "none";
    });

    socket.on("bulkComplete", ({ total }) => {
        isSending = false;
        sendLog.innerHTML += `<div class="log-entry">Completed sending to ${total} numbers</div>`;
        sendBulkBtn.style.display = "block";
        pauseBulkBtn.style.display = "none";
        document.getElementById("bulkProgress").style.width = "100%";
    });

    socket.on("bulkError", ({ message }) => {
        isSending = false;
        sendLog.innerHTML += `<div class="log-entry error">Error: ${message}</div>`;
        sendBulkBtn.style.display = "block";
        pauseBulkBtn.style.display = "none";
    });

    socket.on("geminiPrompts", prompts => {
        const promptSelect = document.getElementById("promptSelect");
        const promptSelectGemini = document.getElementById("promptSelectGemini");
        promptSelect.innerHTML = prompts.map(prompt => `<option value="${prompt}">${prompt}</option>`).join("");
        promptSelectGemini.innerHTML = prompts.map(prompt => `<option value="${prompt}">${prompt}</option>`).join("");
    });

    async function fetchQrStatus() {
        try {
            const data = await window.electronAPI.getQR(token);
            console.log("Fetched QR status:", data);
            if (data.authenticated) {
                qrCanvas.innerHTML = "";
                qrStatus.textContent = "Connected Successfully!";
                isAuthenticated = true;
                updateTabVisibility();
                updateMessages();
                updatePolls();
            } else if (data.qr) {
                qrStatus.textContent = "Scan QR Code to Connect";
                displayQrCode(data.qr);
                isAuthenticated = false;
                updateTabVisibility();
            } else {
                qrStatus.textContent = "Waiting for QR Code...";
            }
        } catch (error) {
            qrStatus.textContent = "Please complete authentication first";
            console.error('Error fetching QR status:', error.message);
        }
    }

    async function updateMessages() {
        if (!isAuthenticated) {
            console.log("Skipping updateMessages: Not authenticated yet");
            return;
        }
        try {
            messages = await window.electronAPI.getMessages(token);
            document.getElementById("messageList").innerHTML = messages.map(m => 
                `<div class="message">
                    <strong>From:</strong> ${m.from}<br>
                    <strong>Message:</strong> ${m.body}<br>
                    <strong>Time:</strong> ${m.timestamp}
                </div>`
            ).join("");
        } catch (error) {
            console.error('Error fetching messages:', error);
        }
    }

    async function updatePolls(pollsData = null, votes = pollVotes) {
        if (!isAuthenticated) {
            console.log("Skipping updatePolls: Not authenticated yet");
            return;
        }
        try {
            const { polls: fetchedPolls, pollVotes: fetchedVotes } = await window.electronAPI.getPolls(token);
            const pollsToUse = pollsData || fetchedPolls;
            pollVotes = fetchedVotes;
            document.getElementById("pollList").innerHTML = Object.entries(pollsToUse).map(([id, poll]) => 
                `<div class="message">
                    <strong>Question:</strong> ${poll.question}<br>
                    <strong>Options:</strong> ${poll.options.join(", ")}<br>
                    <strong>Votes:</strong> ${JSON.stringify(votes[id] || {})}
                </div>`
            ).join("");
        } catch (error) {
            console.error('Error fetching polls:', error);
        }
    }

    async function register() {
        const days = document.getElementById("daysInput").value.trim();
        if (!days || isNaN(days) || days < 1) {
            authStatus.textContent = "Please enter a valid number of days";
            return;
        }
        try {
            const data = await window.electronAPI.register(days);
            authStatus.textContent = data.message || data.error;
        } catch (error) {
            authStatus.textContent = error.message;
        }
    }

    async function verifyOTP() {
        const otp = document.getElementById("otpInput").value.trim();
        try {
            const data = await window.electronAPI.verifyOTP(otp);
            authStatus.textContent = data.message || data.error;
            if (data.token) {
                isAuthenticated = true;
                token = data.token;
                localStorage.setItem("sessionToken", token);
                updateTabVisibility();
                document.querySelector(".tab-btn[data-tab='qr']").click();
            }
        } catch (error) {
            authStatus.textContent = error.message;
            if (error.message.includes("Invalid OTP")) {
                alert("Warning: Invalid OTP. Program will terminate.");
                window.location.reload();
            }
        }
    }

    async function sendMessage() {
        if (!isAuthenticated) return alert("Please authenticate first");
        const number = document.getElementById("number").value.trim();
        const message = document.getElementById("message").value.trim();
        const attachment = document.getElementById("attachment").files[0]?.path;
        if (!number || !message) return alert("Please enter a number and message");

        const sendBtn = document.getElementById("sendBtn");
        sendBtn.disabled = true;
        try {
            await window.electronAPI.sendMessage({ token, number, message, attachment });
            document.getElementById("number").value = "";
            document.getElementById("message").value = "";
            document.getElementById("attachment").value = "";
        } catch (error) {
            alert("Error sending message: " + error.message);
        }
        sendBtn.disabled = false;
    }

    async function sendBulk() {
        if (!isAuthenticated) return alert("Please authenticate first");
        if (isSending) return alert("Bulk send already in progress");
        const numbers = document.getElementById("numbers").value.split("\n").filter(Boolean);
        const message = document.getElementById("bulkMessage").value.trim();
        const type = document.getElementById("bulkType").value;
        const options = document.getElementById("pollOptions").value.split("\n").filter(Boolean);
        const resume = document.getElementById("resume").checked;
        const attachment = document.getElementById("bulkAttachment").files[0]?.path;

        const variables = [];
        const regex = /\{([^}]+)\}/g;
        let match;
        while ((match = regex.exec(message))) {
            const opts = match[1].split(',').map(opt => opt.trim()).filter(opt => opt !== '');
            variables.push(opts);
        }

        if (!numbers.length || !message) return alert("Please enter numbers and a message");

        try {
            await window.electronAPI.sendBulk({
                token,
                numbers,
                message,
                type,
                options,
                resume,
                variables,
                settings,
                attachment
            });
        } catch (error) {
            sendLog.innerHTML += `<div class="log-entry error">Error: ${error.message}</div>`;
        }
    }

    async function pauseBulk() {
        if (!isSending) return alert("No bulk send in progress");
        try {
            await window.electronAPI.pauseBulk(token);
        } catch (error) {
            sendLog.innerHTML += `<div class="log-entry error">Error pausing: ${error.message}</div>`;
        }
    }

    async function savePrompt() {
        if (!isAuthenticated) return alert("Please authenticate first");
        const newPrompt = document.getElementById("geminiResponse").value.trim();
        try {
            const prompts = await window.electronAPI.savePrompt({ token, prompt: newPrompt });
            document.getElementById("geminiResponse").value = "Saved your prompt. Check and select from dropdown.";
            socket.emit("geminiPrompts", prompts);
        } catch (error) {
            alert("Error saving prompt: " + error.message);
        }
    }

    async function generateResponse() {
        if (!isAuthenticated) return alert("Please authenticate first");
        const prompt = document.getElementById("promptSelectGemini").value;
        const generateBtn = document.getElementById("generateBtn");
        generateBtn.disabled = true;
        try {
            const { response } = await window.electronAPI.generateResponse({ token, prompt });
            geminiResponse = response;
            document.getElementById("geminiResponse").value = response;
        } catch (error) {
            document.getElementById("geminiResponse").value = "Error: " + error.message;
        }
        generateBtn.disabled = false;
    }

    async function generateMarketingPost() {
        if (!isAuthenticated) return alert("Please authenticate first");
        const companyName = document.getElementById("companyName").value.trim();
        const productDetails = document.getElementById("productDetails").value.trim();
        const targetGender = document.getElementById("targetGender").value;
        const targetAudience = document.getElementById("targetAudience").value.trim();
        const tone = document.getElementById("tone").value.trim();
        const keySellingPoints = document.getElementById("keySellingPoints").value.trim();
        const callToAction = document.getElementById("callToAction").value.trim();
        const currentPromotion = document.getElementById("currentPromotion").value.trim();

        if (!companyName || !productDetails || !targetAudience || !tone || !keySellingPoints || !callToAction || !currentPromotion) {
            return alert("Please fill in all fields");
        }

        const generateBtn = document.getElementById("generateMarketingBtn");
        generateBtn.disabled = true;

        try {
            const prompt = `
                As a expert WhatsApp marketer, create a gender-optimized message with:
                Company: ${companyName}
                Product: ${productDetails}
                Target Gender: ${targetGender}
                Audience: ${targetAudience}
                Tone: ${tone}
                Key Points: ${keySellingPoints}
                CTA: ${callToAction}
                Current offer: ${currentPromotion}
            `;
            const { response } = await window.electronAPI.generateResponse({ token, prompt });
            geminiResponse = response;
            document.getElementById("geminiResponse").value = response;
        } catch (error) {
            document.getElementById("geminiResponse").value = "Error: " + error.message;
        } finally {
            generateBtn.disabled = false;
        }
    }

    document.getElementById("bulkType").addEventListener("change", e => {
        document.getElementById("pollOptions").style.display = e.target.value === "poll" ? "block" : "none";
    });

    document.getElementById("registerBtn").addEventListener("click", register);
    document.getElementById("verifyBtn").addEventListener("click", verifyOTP);
    document.getElementById("sendBtn").addEventListener("click", sendMessage);
    document.getElementById("sendBulkBtn").addEventListener("click", sendBulk);
    document.getElementById("pauseBulkBtn").addEventListener("click", pauseBulk);
    document.getElementById("generateDullBtn").addEventListener("click", generateAndSetDullText);
    document.getElementById("generateMarketingBtn").addEventListener("click", generateMarketingPost);
    document.getElementById("savePromptBtn").addEventListener("click", savePrompt);
    document.getElementById("generateBtn").addEventListener("click", generateResponse);
    document.getElementById("saveSettingsBtn").addEventListener("click", saveSettings);

    updateTabVisibility();
    fetchQrStatus();
});
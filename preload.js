const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    register: (days) => ipcRenderer.invoke('register', days),
    verifyOTP: (otp) => ipcRenderer.invoke('verify-otp', otp),
    getQR: (token) => ipcRenderer.invoke('get-qr', token),
    sendMessage: (data) => ipcRenderer.invoke('send-message', data), // Passes { token, number, message, attachment }
    sendBulk: (data) => ipcRenderer.invoke('send-bulk', data),       // Passes { token, numbers, message, type, options, resume, variables, settings, attachment }
    pauseBulk: (token) => ipcRenderer.invoke('pause-bulk', token),
    generateResponse: (data) => ipcRenderer.invoke('generate-response', data),
    getMessages: (token) => ipcRenderer.invoke('get-messages', token),
    getPolls: (token) => ipcRenderer.invoke('get-polls', token),
    savePrompt: (data) => ipcRenderer.invoke('save-prompt', data),
    getAnalytics: (data) => ipcRenderer.invoke('get-analytics', data),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
    updateSettings: (data) => ipcRenderer.invoke('update-settings', data),
    getSettings: (token) => ipcRenderer.invoke('get-settings', token),
    onSettingsUpdate: (callback) => ipcRenderer.on('settings-updated', callback),
    removeSettingsUpdateListener: () => ipcRenderer.removeAllListeners('settings-updated'),
    
    // New Chat and Agent APIs
    getChats: (token) => ipcRenderer.invoke('get-chats', token),
    getChatHistory: ({ token, chatId }) => ipcRenderer.invoke('get-chat-history', { token, chatId }),
    sendChatMessage: ({ token, chatId, message, attachment }) => ipcRenderer.invoke('send-chat-message', { token, chatId, message, attachment }),
    
    // Agent APIs
    startAgent: ({ token, chatId, settings }) => ipcRenderer.invoke('start-agent', { token, chatId, settings }),
    stopAgent: ({ token, chatId }) => ipcRenderer.invoke('stop-agent', { token, chatId }),
    getAgentStatus: (token) => ipcRenderer.invoke('get-agent-status', token),
    updateAgentSettings: ({ token, settings }) => ipcRenderer.invoke('update-agent-settings', { token, settings }),
    getAgentSettings: (token) => ipcRenderer.invoke('get-agent-settings', token),
    
    // Event listeners
    onNewMessage: (callback) => ipcRenderer.on('new-message', callback),
    onAgentResponse: (callback) => ipcRenderer.on('agent-response', callback),
    onAgentStatusChange: (callback) => ipcRenderer.on('agent-status-change', callback),
    onMessageAck: (callback) => ipcRenderer.on('message-ack-update', callback),
    
    // Remove listeners
    removeListeners: () => {
        ipcRenderer.removeAllListeners('new-message');
        ipcRenderer.removeAllListeners('agent-response');
        ipcRenderer.removeAllListeners('agent-status-change');
        ipcRenderer.removeAllListeners('message-ack-update');
    }
});
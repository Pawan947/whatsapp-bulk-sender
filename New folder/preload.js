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
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args))
});
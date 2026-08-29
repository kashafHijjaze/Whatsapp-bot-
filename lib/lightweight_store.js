const fs = require('fs')
const STORE_FILE = './baileys_store.json'

// Config: keep last 300 messages per chat and 3000 in global index for high reliability
let MAX_MESSAGES = 300
const MAX_GLOBAL_INDEX = 3000

// Try to read config from settings
try {
    const settings = require('../settings.js')
    if (settings.maxStoreMessages && typeof settings.maxStoreMessages === 'number' && settings.maxStoreMessages > 0) {
        MAX_MESSAGES = settings.maxStoreMessages
    }
} catch (e) {
    // Use default if settings not available
}

const store = {
    messages: {},
    contacts: {},
    chats: {},
    indexedMessages: new Map(),

    readFromFile(filePath = STORE_FILE) {
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
                this.contacts = data.contacts || {}
                this.chats = data.chats || {}
                this.messages = data.messages || {}
                
                // Clean up any existing data and populate global index
                this.cleanupData()
            }
        } catch (e) {
            console.warn('Failed to read store file:', e.message)
        }
    },

    writeToFile(filePath = STORE_FILE) {
        try {
            const data = JSON.stringify({
                contacts: this.contacts,
                chats: this.chats,
                messages: this.messages
            })
            fs.writeFileSync(filePath, data)
        } catch (e) {
            console.warn('Failed to write store file:', e.message)
        }
    },

    cleanupData() {
        if (this.messages) {
            Object.keys(this.messages).forEach(jid => {
                if (typeof this.messages[jid] === 'object' && !Array.isArray(this.messages[jid])) {
                    const messages = Object.values(this.messages[jid])
                    this.messages[jid] = messages.slice(-MAX_MESSAGES)
                }
                if (Array.isArray(this.messages[jid])) {
                    for (const m of this.messages[jid]) {
                        if (m?.key?.id) {
                            this.indexMessage(m)
                        }
                    }
                }
            })
        }
    },

    indexMessage(msg) {
        if (!msg || !msg.key || !msg.key.id) return
        this.indexedMessages.set(msg.key.id, msg)
        if (this.indexedMessages.size > MAX_GLOBAL_INDEX) {
            const firstKey = this.indexedMessages.keys().next().value
            this.indexedMessages.delete(firstKey)
        }
    },

    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            if (!Array.isArray(messages)) return
            messages.forEach(msg => {
                if (!msg?.key) return
                
                // Index globally by ID immediately
                if (msg.key.id) {
                    this.indexMessage(msg)
                }

                const jid = msg.key.remoteJid
                if (!jid) return

                this.messages[jid] = this.messages[jid] || []

                // Check if already in chat array
                const existingIdx = this.messages[jid].findIndex(m => m.key?.id === msg.key.id)
                if (existingIdx >= 0) {
                    this.messages[jid][existingIdx] = msg
                } else {
                    this.messages[jid].push(msg)
                }

                // trim old ones
                if (this.messages[jid].length > MAX_MESSAGES) {
                    this.messages[jid] = this.messages[jid].slice(-MAX_MESSAGES)
                }
            })
        })

        ev.on('messages.update', (updates) => {
            if (!Array.isArray(updates)) return
            updates.forEach(u => {
                if (!u?.key?.id) return
                const existing = this.indexedMessages.get(u.key.id)
                if (existing) {
                    Object.assign(existing, u)
                }
            })
        })

        ev.on('contacts.update', (contacts) => {
            contacts.forEach(contact => {
                if (contact.id) {
                    this.contacts[contact.id] = {
                        id: contact.id,
                        name: contact.notify || contact.name || ''
                    }
                }
            })
        })

        ev.on('chats.set', (chats) => {
            this.chats = {}
            chats.forEach(chat => {
                this.chats[chat.id] = { id: chat.id, subject: chat.subject || '' }
            })
        })
    },

    async loadMessage(jid, id) {
        if (!id) return null
        
        // 1. First check high-speed global index
        if (this.indexedMessages && this.indexedMessages.has(id)) {
            return this.indexedMessages.get(id)
        }

        // 2. Check specified chat
        if (jid && this.messages[jid]) {
            const found = this.messages[jid].find(m => m.key?.id === id)
            if (found) {
                this.indexMessage(found)
                return found
            }
        }

        // 3. Check across all stored chats
        if (this.messages) {
            for (const chatJid of Object.keys(this.messages)) {
                const arr = this.messages[chatJid]
                if (Array.isArray(arr)) {
                    const found = arr.find(m => m.key?.id === id)
                    if (found) {
                        this.indexMessage(found)
                        return found
                    }
                }
            }
        }

        return null
    },

    // Get store statistics
    getStats() {
        let totalMessages = 0
        let totalContacts = Object.keys(this.contacts).length
        let totalChats = Object.keys(this.chats).length
        
        Object.values(this.messages).forEach(chatMessages => {
            if (Array.isArray(chatMessages)) {
                totalMessages += chatMessages.length
            }
        })
        
        return {
            messages: totalMessages,
            indexedMessages: this.indexedMessages.size,
            contacts: totalContacts,
            chats: totalChats,
            maxMessagesPerChat: MAX_MESSAGES
        }
    }
}

module.exports = store


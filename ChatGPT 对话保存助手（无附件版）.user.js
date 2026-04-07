// ==UserScript==
// @name         ChatGPT 对话保存助手（无附件版）
// @namespace    https://github.com/a182860089-pixel/massage
// @version      4.2.0-lite
// @description  自动保存 ChatGPT 对话，支持导出 HTML / Markdown / PDF / JSON，上下文导入；已移除附件保存功能
// @author       ChatGPT
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://*.openai.com/*
// @match        https://*.chatgpt.com/*
// @icon         https://chat.openai.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @require      https://unpkg.com/turndown@7.1.2/dist/turndown.js
// @require      https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    autoSave: true,
    debounceDelay: 3000,
    formats: GM_getValue('formats', { html: true, md: true, pdf: true, json: true }),
    showPanel: GM_getValue('showPanel', false),
    saveMode: GM_getValue('saveMode', 'download')
  };

  const DB_NAME = 'ChatGPTSaverLiteDB';
  const DB_STORE = 'fileHandles';
  const DB_KEY = 'rootFolderHandle';

  let savedFolderHandle = null;
  let uiReady = false;
  let lastURL = window.location.href;
  let urlCheckInterval = null;

  const Utils = {
    sanitizeFileName(name) {
      return String(name || '未命名对话')
        .replace(/[/\\:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || '未命名对话';
    },

    getTimestamp() {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      return `${y}${m}${d}_${hh}${mm}${ss}`;
    },

    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    },

    downloadFile(content, filename, mimeType) {
      const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },

    isFileSystemSupported() {
      return typeof window.showDirectoryPicker === 'function';
    },

    async openDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            db.createObjectStore(DB_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
    },

    async saveHandleToDB(handle) {
      try {
        const db = await this.openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).put(handle, DB_KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        });
      } catch (error) {
        console.warn('[ChatGPT Saver Lite] 保存文件夹句柄失败:', error);
        return false;
      }
    },

    async getHandleFromDB() {
      try {
        const db = await this.openDB();
        return await new Promise((resolve) => {
          const tx = db.transaction(DB_STORE, 'readonly');
          const request = tx.objectStore(DB_STORE).get(DB_KEY);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
        });
      } catch {
        return null;
      }
    },

    async clearHandleFromDB() {
      try {
        const db = await this.openDB();
        return await new Promise((resolve) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(DB_KEY);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        });
      } catch {
        return false;
      }
    },

    async tryRestoreAccess() {
      if (!this.isFileSystemSupported()) {
        return { success: false, reason: 'unsupported' };
      }

      const handle = await this.getHandleFromDB();
      if (!handle) {
        return { success: false, reason: 'missing' };
      }

      try {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          savedFolderHandle = handle;
          CONFIG.saveMode = 'folder';
          GM_setValue('saveMode', 'folder');
          GM_setValue('savedFolderName', handle.name || '已选择');
          return { success: true, handle };
        }
        return { success: false, reason: 'permission', handle };
      } catch (error) {
        await this.clearHandleFromDB();
        return { success: false, reason: 'invalid', error };
      }
    },

    async requestPermissionForSavedHandle(handle) {
      try {
        const permission = await handle.requestPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          savedFolderHandle = handle;
          CONFIG.saveMode = 'folder';
          GM_setValue('saveMode', 'folder');
          GM_setValue('savedFolderName', handle.name || '已选择');
          return true;
        }
      } catch (error) {
        console.warn('[ChatGPT Saver Lite] 重新授权失败:', error);
      }
      return false;
    },

    async selectFolder() {
      if (!this.isFileSystemSupported()) {
        throw new Error('当前浏览器不支持文件夹选择，请使用最新版 Chrome 或 Edge');
      }
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      savedFolderHandle = handle;
      CONFIG.saveMode = 'folder';
      GM_setValue('saveMode', 'folder');
      GM_setValue('savedFolderName', handle.name || '已选择');
      await this.saveHandleToDB(handle);
      return handle;
    },

    async getOrCreateFolder(parentHandle, folderName) {
      if (!parentHandle) throw new Error('文件夹句柄无效');

      const permission = await parentHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const requestPermission = await parentHandle.requestPermission({ mode: 'readwrite' });
        if (requestPermission !== 'granted') {
          throw new Error('文件夹访问权限被拒绝');
        }
      }

      return parentHandle.getDirectoryHandle(folderName, { create: true });
    },

    async saveToFolder(folderHandle, filename, content, mimeType, retryCount = 0) {
      const MAX_RETRIES = 3;

      try {
        const permission = await folderHandle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
          const requestPermission = await folderHandle.requestPermission({ mode: 'readwrite' });
          if (requestPermission !== 'granted') {
            throw new Error('文件夹访问权限被拒绝');
          }
        }

        const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
        const fileHandle = await folderHandle.getFileHandle(filename, { create: true });

        let writable;
        try {
          writable = await fileHandle.createWritable();
        } catch (streamError) {
          if (
            retryCount < MAX_RETRIES &&
            (streamError.name === 'InvalidStateError' || streamError.name === 'NoModificationAllowedError')
          ) {
            await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
            return this.saveToFolder(folderHandle, filename, content, mimeType, retryCount + 1);
          }
          throw streamError;
        }

        await writable.write(blob);
        await writable.close();
        return true;
      } catch (e) {
        if (e.name === 'InvalidStateError' && retryCount < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
          return this.saveToFolder(folderHandle, filename, content, mimeType, retryCount + 1);
        }
        console.error('[ChatGPT Saver Lite] 保存文件失败:', filename, e);
        return false;
      }
    },

    async readFileContent(folderHandle, filename) {
      try {
        const fileHandle = await folderHandle.getFileHandle(filename, { create: false });
        const file = await fileHandle.getFile();
        return await file.text();
      } catch {
        return null;
      }
    },

    async createConversationFolders(rootHandle, workspaceName, conversationTitle) {
      const safeWorkspace = this.sanitizeFileName(workspaceName || '个人帐户');
      const safeTitle = this.sanitizeFileName(conversationTitle);

      const workspaceFolder = await this.getOrCreateFolder(rootHandle, safeWorkspace);
      const conversationFolder = await this.getOrCreateFolder(workspaceFolder, safeTitle);
      const htmlFolder = await this.getOrCreateFolder(conversationFolder, 'html');
      const mdFolder = await this.getOrCreateFolder(conversationFolder, 'md');
      const pdfFolder = await this.getOrCreateFolder(conversationFolder, 'pdf');
      const contextFolder = await this.getOrCreateFolder(conversationFolder, 'context');

      return {
        workspace: workspaceFolder,
        conversation: conversationFolder,
        html: htmlFolder,
        md: mdFolder,
        pdf: pdfFolder,
        context: contextFolder,
        workspaceName: safeWorkspace,
        title: safeTitle
      };
    },

    async saveConversationToFolder(rootHandle, workspaceName, conversationTitle, htmlContent, mdContent, pdfBlob, contextJson, formats, meta) {
      try {
        if (!rootHandle) {
          return {
            success: false,
            error: '保存文件夹未设置，请先选择保存文件夹',
            needReselectFolder: true
          };
        }

        const permission = await rootHandle.queryPermission({ mode: 'readwrite' });
        if (permission !== 'granted') {
          const requestPermission = await rootHandle.requestPermission({ mode: 'readwrite' });
          if (requestPermission !== 'granted') {
            return {
              success: false,
              error: '文件夹访问权限被拒绝，请重新选择保存文件夹',
              needReselectFolder: true
            };
          }
        }

        const folders = await this.createConversationFolders(rootHandle, workspaceName, conversationTitle);
        const saved = [];
        const failed = [];

        if (formats.html && htmlContent) {
          const ok = await this.saveToFolder(folders.html, `${folders.title}.html`, htmlContent, 'text/html');
          ok ? saved.push('HTML') : failed.push('HTML');
        }

        if (formats.md && mdContent) {
          const ok = await this.saveToFolder(folders.md, `${folders.title}.md`, mdContent, 'text/markdown');
          ok ? saved.push('MD') : failed.push('MD');
        }

        if (formats.pdf && pdfBlob) {
          const ok = await this.saveToFolder(folders.pdf, `${folders.title}.pdf`, pdfBlob, 'application/pdf');
          ok ? saved.push('PDF') : failed.push('PDF');
        }

        if (formats.json && contextJson) {
          const ok = await this.saveToFolder(folders.context, `${folders.title}.json`, contextJson, 'application/json');
          ok ? saved.push('JSON') : failed.push('JSON');
        }

        if (meta) {
          await this.saveToFolder(
            folders.conversation,
            '_meta.json',
            JSON.stringify(meta, null, 2),
            'application/json'
          );
        }

        if (saved.length === 0) {
          return {
            success: false,
            error: `保存失败: ${failed.join(', ') || '未知错误'}`,
            failed,
            needReselectFolder: failed.length > 0
          };
        }

        return {
          success: true,
          saved,
          failed: failed.length ? failed : undefined,
          path: `${folders.workspaceName}/${folders.title}`
        };
      } catch (e) {
        return {
          success: false,
          error: e.message || '未知错误',
          needReselectFolder: true
        };
      }
    },

    async checkConversationNeedsUpdate(rootHandle, workspaceName, conversationTitle, currentMessageCount) {
      try {
        const safeWorkspace = this.sanitizeFileName(workspaceName || '个人帐户');
        const safeTitle = this.sanitizeFileName(conversationTitle);

        let workspaceFolder;
        try {
          workspaceFolder = await rootHandle.getDirectoryHandle(safeWorkspace, { create: false });
        } catch {
          return { needsUpdate: true, reason: 'new', savedCount: 0 };
        }

        let conversationFolder;
        try {
          conversationFolder = await workspaceFolder.getDirectoryHandle(safeTitle, { create: false });
        } catch {
          return { needsUpdate: true, reason: 'new', savedCount: 0 };
        }

        const metaText = await this.readFileContent(conversationFolder, '_meta.json');
        if (!metaText) {
          return { needsUpdate: true, reason: 'no_meta', savedCount: 0 };
        }

        try {
          const meta = JSON.parse(metaText);
          const savedMessageCount = Number(meta.messageCount || 0);
          if (currentMessageCount > savedMessageCount) {
            return {
              needsUpdate: true,
              reason: 'updated',
              savedCount: savedMessageCount,
              currentCount: currentMessageCount
            };
          }

          return {
            needsUpdate: false,
            reason: 'unchanged',
            savedCount: savedMessageCount,
            currentCount: currentMessageCount,
            path: `${safeWorkspace}/${safeTitle}`
          };
        } catch {
          return { needsUpdate: true, reason: 'bad_meta', savedCount: 0 };
        }
      } catch (e) {
        console.error('[ChatGPT Saver Lite] 检查对话状态失败:', e);
        return { needsUpdate: true, reason: 'error', savedCount: 0 };
      }
    },

    async yieldFrame(ms = 0) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  };

  const Parser = {
    getConversationTitle() {
      const pageTitle = document.title;
      if (pageTitle && pageTitle !== 'ChatGPT' && !pageTitle.startsWith('ChatGPT')) {
        const title = pageTitle
          .replace(/\s*[-|｜]\s*ChatGPT.*$/i, '')
          .replace(/^ChatGPT\s*[-|｜]\s*/i, '')
          .trim();
        if (title) return title;
      }

      const sidebarSelectors = [
        'nav li[class*="bg-"] a',
        'nav [data-testid="history-item"][class*="bg-"]',
        'nav a[class*="bg-token-sidebar-surface-secondary"]',
        'nav [aria-current="page"]'
      ];

      for (const selector of sidebarSelectors) {
        const activeItem = document.querySelector(selector);
        if (activeItem) {
          const textContent = activeItem.textContent?.trim();
          if (textContent && textContent.length > 0 && textContent.length < 200) {
            return textContent;
          }
        }
      }

      const firstUserMessage = this.getFirstUserMessage();
      if (firstUserMessage) {
        const text = firstUserMessage.trim();
        if (text.length > 0) {
          return text.substring(0, 50) + (text.length > 50 ? '...' : '');
        }
      }

      const urlMatch = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
      if (urlMatch) {
        return `对话_${urlMatch[1].substring(0, 8)}`;
      }

      return `ChatGPT对话_${new Date().toLocaleDateString('zh-CN')}`;
    },

    getFirstUserMessage() {
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      if (userMessages.length > 0) {
        const contentEl = userMessages[0].querySelector('.whitespace-pre-wrap') || userMessages[0];
        return contentEl.textContent?.trim() || '';
      }
      return '';
    },

    getWorkspaceName() {
      const workspaceButtons = document.querySelectorAll('[class*="__menu-item"][class*="gap-2"]:not([class*="gap-2.5"])');
      for (const btn of workspaceButtons) {
        const text = btn.textContent?.trim();
        if (text && text.length >= 2 && text.length <= 60) {
          if (
            text.includes('@') ||
            text.includes('新') ||
            text.includes('搜索') ||
            text.includes('设置') ||
            text.includes('帮助') ||
            text.includes('退出') ||
            text.includes('Ctrl')
          ) {
            continue;
          }
          const nameEl = btn.querySelector('.line-clamp-1');
          let workspaceName = nameEl ? nameEl.textContent?.trim() : text;
          if (workspaceName) {
            if (workspaceName === '个人帐户' || workspaceName.toLowerCase().includes('personal')) {
              return '个人帐户';
            }
            return workspaceName;
          }
        }
      }

      const candidates = [
        ...document.querySelectorAll('[data-testid*="workspace"], button, [role="button"], nav *')
      ]
        .map(el => el.textContent?.trim())
        .filter(Boolean);

      for (const text of candidates) {
        if (!text) continue;
        if (text === '个人帐户' || /personal/i.test(text)) return '个人帐户';
        if (
          text.length >= 2 &&
          text.length <= 60 &&
          !text.includes('@') &&
          !/搜索|设置|帮助|退出|upgrade|settings|help|log out/i.test(text)
        ) {
          if (/team|workspace|团队|空间/i.test(text)) return text;
        }
      }

      return '个人帐户';
    },

    getMessageElements() {
      let messages = document.querySelectorAll('[data-message-author-role]');
      if (messages.length > 0) {
        return Array.from(messages);
      }

      const fallbackSelectors = [
        'main article[data-testid]',
        'main [class*="group/conversation-turn"]'
      ];

      for (const selector of fallbackSelectors) {
        messages = document.querySelectorAll(selector);
        if (messages.length > 0) {
          return Array.from(messages);
        }
      }
      return [];
    },

    parseMessage(messageEl) {
      const role = messageEl.getAttribute('data-message-author-role');
      const isUser = role === 'user';
      const isAssistant = role === 'assistant';

      let contentEl = null;
      if (isUser) {
        contentEl = messageEl.querySelector('.whitespace-pre-wrap') ||
          messageEl.querySelector('[data-message-content]');
      }
      if (isAssistant) {
        contentEl = messageEl.querySelector('[class*="markdown"]') ||
          messageEl.querySelector('.prose');
      }
      if (!contentEl) {
        contentEl = messageEl.querySelector('[class*="markdown"]') ||
          messageEl.querySelector('.prose') ||
          messageEl.querySelector('.whitespace-pre-wrap');
      }
      if (!contentEl) contentEl = messageEl;

      const clonedContent = contentEl.cloneNode(true);
      clonedContent.querySelectorAll('button, [class*="copy"], svg').forEach(el => {
        if (el.closest('[class*="markdown"]') === null || el.tagName === 'BUTTON') {
          el.remove();
        }
      });

      const textContent = clonedContent.textContent.trim();
      if (textContent.length < 2) return null;

      return {
        role: isUser ? 'user' : (isAssistant ? 'assistant' : 'system'),
        content: clonedContent.innerHTML,
        textContent
      };
    },

    parseConversation() {
      const title = this.getConversationTitle();
      const messageElements = this.getMessageElements();
      const messages = [];

      messageElements.forEach(el => {
        try {
          const message = this.parseMessage(el);
          if (message && message.textContent && message.textContent.length > 1) {
            messages.push(message);
          }
        } catch (error) {
          console.error('[ChatGPT Saver Lite] 解析消息失败:', error);
        }
      });

      return {
        title,
        workspace: this.getWorkspaceName(),
        messages,
        timestamp: new Date().toISOString(),
        url: window.location.href
      };
    },

    isGPTTyping() {
      const typingIndicators = [
        '[class*="result-streaming"]',
        '[class*="streaming"]',
        '[data-testid="stop-button"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="停止生成"]',
        'button[data-testid="stop-button"]',
        'button[class*="stop"]',
        '[data-state="streaming"]'
      ];

      for (const selector of typingIndicators) {
        try {
          const el = document.querySelector(selector);
          if (el && el.offsetParent !== null) {
            return true;
          }
        } catch {}
      }
      return false;
    },

    getContentHash() {
      const messages = this.getMessageElements();
      const content = messages.map(m => m.textContent).join('');
      let hash = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash.toString();
    }
  };

  const HTMLExporter = {
    export(conversation) {
      if (!conversation.messages.length) return null;

      return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${Utils.escapeHtml(conversation.title)} - ChatGPT 对话记录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', Roboto, sans-serif;
      line-height: 1.6; background: #f7f7f8; color: #374151;
    }
    .container { max-width: 850px; margin: 0 auto; padding: 40px 20px; }
    .chat-header {
      background: linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%);
      color: white; padding: 30px; border-radius: 16px; margin-bottom: 30px;
      box-shadow: 0 4px 20px rgba(16, 163, 127, 0.3);
    }
    .chat-header h1 { font-size: 24px; font-weight: 600; margin-bottom: 12px; }
    .chat-header .meta { font-size: 14px; opacity: 0.9; display:flex; flex-wrap:wrap; gap:10px; }
    .chat-content { display: flex; flex-direction: column; gap: 20px; }
    .message {
      background: white; border-radius: 12px; padding: 20px 24px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    }
    .message.user { border-left: 4px solid #10a37f; }
    .message.assistant { border-left: 4px solid #6366f1; }
    .message .role {
      display: flex; align-items: center; gap: 8px; font-weight: 600;
      font-size: 14px; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid #f0f0f0;
    }
    .message.user .role { color: #10a37f; }
    .message.assistant .role { color: #6366f1; }
    .message .content { font-size: 15px; line-height: 1.7; }
    .message .content pre {
      background: #1e1e1e; color: #d4d4d4; padding: 16px 20px;
      border-radius: 8px; overflow-x: auto; margin: 16px 0; font-size: 13px;
    }
    .message .content pre code { font-family: 'Monaco', 'Menlo', monospace; background: transparent; }
    .message .content :not(pre) > code {
      background: #f3f4f6; padding: 2px 6px; border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace; font-size: 0.9em; color: #ef4444;
    }
    .chat-footer {
      text-align: center; margin-top: 40px; padding-top: 20px;
      border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="chat-header">
      <h1>${Utils.escapeHtml(conversation.title)}</h1>
      <div class="meta">
        <span>📅 导出时间: ${new Date().toLocaleString('zh-CN')}</span>
        <span>💬 共 ${conversation.messages.length} 条消息</span>
        <span>📁 空间: ${Utils.escapeHtml(conversation.workspace)}</span>
      </div>
    </header>
    <div class="chat-content">
      ${conversation.messages.map(msg => `
        <div class="message ${msg.role}">
          <div class="role">
            <span>${msg.role === 'user' ? '👤 用户' : '🤖 ChatGPT'}</span>
          </div>
          <div class="content">${msg.content}</div>
        </div>
      `).join('')}
    </div>
    <footer class="chat-footer">
      <p>由 ChatGPT 对话保存助手（无附件版）导出 | ${window.location.href}</p>
    </footer>
  </div>
</body>
</html>`;
    }
  };

  const MarkdownExporter = {
    turndownService: null,

    init() {
      if (this.turndownService) return;
      if (typeof TurndownService === 'undefined') {
        console.error('Turndown.js 未加载');
        return;
      }

      this.turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-'
      });

      this.turndownService.addRule('codeBlock', {
        filter: node => node.nodeName === 'PRE' && node.querySelector('code'),
        replacement: (content, node) => {
          const codeEl = node.querySelector('code');
          const code = codeEl.textContent;
          let language = '';
          const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
          if (langClass) language = langClass.replace('language-', '');
          return '\n\n```' + language + '\n' + code + '\n```\n\n';
        }
      });

      this.turndownService.addRule('removeButtons', {
        filter: node => node.nodeName === 'BUTTON',
        replacement: () => ''
      });
    },

    export(conversation) {
      this.init();
      if (!conversation.messages.length) return null;

      let markdown = `# ${conversation.title}\n\n`;
      markdown += `> 📅 导出时间: ${new Date().toLocaleString('zh-CN')}  \n`;
      markdown += `> 💬 共 ${conversation.messages.length} 条消息  \n`;
      markdown += `> 📁 空间: ${conversation.workspace}  \n`;
      markdown += `> 🔗 来源: ${conversation.url}\n\n`;
      markdown += `---\n\n`;

      conversation.messages.forEach((msg, index) => {
        const roleLabel = msg.role === 'user' ? '## 👤 用户' : '## 🤖 ChatGPT';
        markdown += `${roleLabel}\n\n`;

        let msgContent = msg.content;
        if (this.turndownService) {
          try {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = msg.content;
            tempDiv.querySelectorAll('button').forEach(el => el.remove());
            msgContent = this.turndownService.turndown(tempDiv);
            msgContent = msgContent.replace(/\n{3,}/g, '\n\n');
          } catch {
            msgContent = msg.textContent;
          }
        } else {
          msgContent = msg.textContent;
        }

        markdown += msgContent.trim() + '\n\n';
        if (index < conversation.messages.length - 1) {
          markdown += `---\n\n`;
        }
      });

      markdown += `\n---\n\n*由 ChatGPT 对话保存助手（无附件版）导出*\n`;
      return markdown;
    }
  };

  const PDFExporter = {
    isAvailable() {
      return typeof html2canvas !== 'undefined' && typeof jspdf !== 'undefined';
    },

    async yieldToMain() {
      return new Promise(resolve => {
        if ('requestIdleCallback' in window) {
          requestIdleCallback(resolve, { timeout: 50 });
        } else {
          setTimeout(resolve, 0);
        }
      });
    },

    async export(conversation) {
      if (!this.isAvailable()) {
        console.error('PDF 导出库未加载');
        return null;
      }

      if (!conversation.messages.length) return null;

      let container = null;

      try {
        const { jsPDF } = jspdf;
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

        const pageWidth = 210;
        const pageHeight = 297;
        const margin = 15;
        const contentWidth = pageWidth - margin * 2;
        const contentHeight = pageHeight - margin * 2 - 24;

        container = this.createPDFContainer(conversation, contentWidth);
        document.body.appendChild(container);

        await new Promise(resolve => setTimeout(resolve, 500));
        await this.yieldToMain();

        const images = container.querySelectorAll('img');
        if (images.length > 0) {
          await Promise.all(Array.from(images).map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
              img.onload = resolve;
              img.onerror = resolve;
            });
          }));
        }

        const containerRect = container.getBoundingClientRect();

        const canvas = await html2canvas(container, {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          logging: false,
          backgroundColor: '#ffffff',
          width: containerRect.width,
          height: containerRect.height,
          onclone: (clonedDoc) => {
            const clonedContainer = clonedDoc.getElementById('chatgpt-saver-pdf-container');
            if (clonedContainer) {
              clonedContainer.style.position = 'static';
              clonedContainer.style.opacity = '1';
              clonedContainer.style.visibility = 'visible';
              clonedContainer.style.zIndex = 'auto';
            }
          },
          ignoreElements: (element) => {
            return element.tagName === 'SCRIPT' || element.tagName === 'NOSCRIPT';
          }
        });

        if (container && container.parentNode) {
          document.body.removeChild(container);
          container = null;
        }

        if (!canvas || canvas.width === 0 || canvas.height === 0) {
          console.error('html2canvas 返回了无效的 canvas');
          return null;
        }

        const imgWidth = contentWidth;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const totalPages = Math.ceil(imgHeight / contentHeight);

        for (let page = 0; page < totalPages; page++) {
          if (page > 0) pdf.addPage();

          pdf.setFontSize(9);
          pdf.setTextColor(130, 130, 130);
          pdf.text('ChatGPT Saver', margin, 8);
          pdf.text(new Date().toLocaleDateString('en-US'), pageWidth - margin - 20, 8);

          const sourceY = page * contentHeight * (canvas.height / imgHeight);
          const sourceHeight = Math.min(contentHeight * (canvas.height / imgHeight), canvas.height - sourceY);

          const pageCanvas = document.createElement('canvas');
          pageCanvas.width = canvas.width;
          pageCanvas.height = Math.ceil(sourceHeight);
          const ctx = pageCanvas.getContext('2d');

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

          ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);

          const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.92);
          const pageImgHeight = (sourceHeight * imgWidth) / canvas.width;
          pdf.addImage(pageImgData, 'JPEG', margin, margin + 12, imgWidth, pageImgHeight);

          pdf.text(`${page + 1} / ${totalPages}`, pageWidth - margin - 15, pageHeight - 8);

          if (page % 2 === 0) {
            await this.yieldToMain();
          }
        }

        return pdf.output('blob');
      } catch (error) {
        console.error('PDF 生成失败:', error);
        return null;
      } finally {
        if (container && container.parentNode) {
          document.body.removeChild(container);
        }
      }
    },

    createPDFContainer(conversation, widthMM) {
      const widthPx = widthMM * 3.78;
      const container = document.createElement('div');
      container.id = 'chatgpt-saver-pdf-container';

      container.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: ${widthPx}px;
        max-height: none;
        overflow: visible;
        z-index: -9999;
        background: #ffffff;
        background-color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
        padding: 20px;
        line-height: 1.6;
        font-size: 14px;
        color: #000000;
        opacity: 1;
        visibility: visible;
      `;

      const header = document.createElement('div');
      header.style.cssText = `
        text-align: center;
        margin-bottom: 20px;
        padding: 20px;
        background: linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%);
        border-radius: 10px;
        color: #ffffff;
      `;
      header.innerHTML = `
        <h1 style="margin: 0 0 8px 0; font-size: 20px; color: #ffffff;">${Utils.escapeHtml(conversation.title)}</h1>
        <p style="margin: 0; font-size: 12px; opacity: 0.9; color: #ffffff;">
          导出时间: ${new Date().toLocaleString('zh-CN')} | 共 ${conversation.messages.length} 条消息 | 空间: ${Utils.escapeHtml(conversation.workspace)}
        </p>
      `;
      container.appendChild(header);

      conversation.messages.forEach(msg => {
        const isUser = msg.role === 'user';
        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = `
          margin: 15px 0;
          padding: 15px;
          border-radius: 8px;
          background-color: ${isUser ? '#f0fdf4' : '#f8fafc'};
          border-left: 4px solid ${isUser ? '#10a37f' : '#6366f1'};
        `;

        const roleDiv = document.createElement('div');
        roleDiv.style.cssText = `
          font-weight: 600;
          color: ${isUser ? '#10a37f' : '#6366f1'};
          margin-bottom: 10px;
          padding-bottom: 8px;
          border-bottom: 1px solid #e5e5e5;
        `;
        roleDiv.textContent = isUser ? '👤 用户' : '🤖 ChatGPT';
        messageDiv.appendChild(roleDiv);

        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = `
          color: #374151;
          font-size: 13px;
          line-height: 1.7;
          word-wrap: break-word;
          overflow-wrap: break-word;
        `;
        contentDiv.innerHTML = msg.content;

        contentDiv.querySelectorAll('pre').forEach(pre => {
          pre.style.cssText = `
            background-color: #1e1e1e;
            color: #d4d4d4;
            padding: 12px;
            border-radius: 6px;
            overflow-x: auto;
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
            font-size: 12px;
            margin: 10px 0;
          `;
        });

        contentDiv.querySelectorAll('code').forEach(code => {
          if (!code.closest('pre')) {
            code.style.cssText = `
              background-color: #f3f4f6;
              color: #e53e3e;
              padding: 2px 6px;
              border-radius: 4px;
              font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
              font-size: 0.9em;
            `;
          }
        });

        messageDiv.appendChild(contentDiv);
        container.appendChild(messageDiv);
      });

      return container;
    }
  };

  const ContextExporter = {
    htmlToPlainText(html) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;

      tempDiv.querySelectorAll('pre code').forEach(codeEl => {
        const pre = codeEl.closest('pre');
        if (pre) {
          let language = '';
          const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
          if (langClass) language = langClass.replace('language-', '');
          const codeText = codeEl.textContent;
          pre.textContent = '```' + language + '\n' + codeText + '\n```';
        }
      });

      tempDiv.querySelectorAll('code').forEach(codeEl => {
        if (!codeEl.closest('pre')) {
          codeEl.textContent = '`' + codeEl.textContent + '`';
        }
      });

      tempDiv.querySelectorAll('button, svg, [class*="copy"]').forEach(el => el.remove());

      return tempDiv.textContent.trim();
    },

    build(conversation) {
      return {
        version: '4.2.0-lite',
        type: 'single',
        title: conversation.title,
        url: conversation.url,
        workspace: conversation.workspace,
        exportedAt: new Date().toISOString(),
        messageCount: conversation.messages.length,
        messages: conversation.messages.map((msg, index) => ({
          index: index + 1,
          role: msg.role,
          content: this.htmlToPlainText(msg.content)
        }))
      };
    }
  };

  const ContextImporter = {
    modal: null,
    fileInput: null,
    currentData: null,

    ensureModal() {
      if (this.modal) return;

      const modal = document.createElement('div');
      modal.className = 'cgs-import-modal';
      modal.innerHTML = `
        <div class="cgs-import-dialog">
          <div class="cgs-import-head">
            <div class="cgs-import-title">📥 导入上下文 JSON</div>
            <button class="cgs-icon-btn" id="cgs-import-close">✕</button>
          </div>
          <div class="cgs-import-body">
            <div class="cgs-import-hint">请选择此前导出的 JSON 文件。该版本仅导入文本上下文，不会保存或恢复附件。</div>
            <div class="cgs-import-actions">
              <button class="cgs-btn" id="cgs-import-pick">选择 JSON 文件</button>
            </div>
            <pre class="cgs-preview" id="cgs-import-preview">尚未选择文件</pre>
            <label class="cgs-check"><input type="checkbox" id="cgs-auto-send"> 导入后自动发送</label>
          </div>
          <div class="cgs-import-foot">
            <button class="cgs-btn cgs-btn-secondary" id="cgs-import-cancel">取消</button>
            <button class="cgs-btn cgs-btn-primary" id="cgs-import-confirm" disabled>导入到输入框</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      this.modal = modal;

      modal.querySelector('#cgs-import-close').onclick = () => this.hide();
      modal.querySelector('#cgs-import-cancel').onclick = () => this.hide();
      modal.querySelector('#cgs-import-pick').onclick = () => this.fileInput.click();
      modal.querySelector('#cgs-import-confirm').onclick = () => this.confirmImport();
      modal.onclick = (event) => {
        if (event.target === modal) this.hide();
      };

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.addEventListener('change', (e) => this.handleFileChange(e));
      document.body.appendChild(input);
      this.fileInput = input;
    },

    show() {
      this.ensureModal();
      this.currentData = null;
      this.modal.classList.add('show');
      this.modal.querySelector('#cgs-import-preview').textContent = '尚未选择文件';
      this.modal.querySelector('#cgs-import-confirm').disabled = true;
      this.modal.querySelector('#cgs-auto-send').checked = false;
    },

    hide() {
      if (!this.modal) return;
      this.modal.classList.remove('show');
    },

    async handleFileChange(event) {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data || !Array.isArray(data.messages)) {
          throw new Error('文件不是有效的上下文 JSON');
        }

        this.currentData = data;

        const preview = [
          `标题：${data.title || '未命名'}`,
          `消息数：${data.messageCount || data.messages.length}`,
          `导出时间：${data.exportedAt ? new Date(data.exportedAt).toLocaleString('zh-CN') : '未知'}`,
          '',
          ...data.messages.slice(0, 3).map(msg => `[${msg.role}] ${String(msg.content || '').slice(0, 180)}`),
          data.messages.length > 3 ? `\n... 还有 ${data.messages.length - 3} 条消息` : ''
        ].join('\n');

        this.modal.querySelector('#cgs-import-preview').textContent = preview;
        this.modal.querySelector('#cgs-import-confirm').disabled = false;
      } catch (error) {
        UI.showToast(`❌ 读取 JSON 失败：${error.message}`, 'error');
      } finally {
        event.target.value = '';
      }
    },

    buildPrompt(data) {
      const maxChars = 28000;
      const messages = (data.messages || []).map(msg => `【${msg.role === 'user' ? '用户' : 'ChatGPT'}】\n${msg.content || ''}`);

      let content = messages.join('\n\n---\n\n');
      let truncated = false;

      if (content.length > maxChars) {
        content = `${content.slice(0, maxChars)}\n\n[已截断：原上下文过长，请结合已导入内容继续对话]`;
        truncated = true;
      }

      return [
        `以下是之前对话「${data.title || '未命名对话'}」的上下文。请先阅读并理解，再继续当前对话。`,
        truncated ? '注意：由于长度限制，下面的上下文已被截断。' : '',
        '',
        content
      ].filter(Boolean).join('\n');
    },

    async findInput() {
      const selectors = [
        '#prompt-textarea',
        'textarea[data-id="root"]',
        'div[contenteditable="true"]',
        'form textarea'
      ];

      for (let i = 0; i < 20; i += 1) {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) return el;
        }
        await Utils.yieldFrame(200);
      }

      return null;
    },

    async injectText(text) {
      const input = await this.findInput();
      if (!input) throw new Error('未找到输入框');

      if (input.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        input.focus();
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text
        }));
      }

      input.focus();
    },

    async confirmImport() {
      if (!this.currentData) return;

      try {
        const prompt = this.buildPrompt(this.currentData);
        await this.injectText(prompt);
        this.hide();
        UI.showToast('✅ 上下文已导入到输入框', 'success');

        if (this.modal.querySelector('#cgs-auto-send').checked) {
          await Utils.yieldFrame(300);
          UI.triggerSend();
        }
      } catch (error) {
        UI.showToast(`❌ 导入失败：${error.message}`, 'error');
      }
    }
  };

  const UI = {
    root: null,
    panel: null,
    status: null,
    toast: null,
    toastTimer: null,

    init() {
      if (uiReady) return;
      this.installStyles();
      this.createFloatingButton();
      this.createPanel();
      this.createToast();
      this.updateStatus();
      uiReady = true;
    },

    installStyles() {
      GM_addStyle(`
        #chatgpt-saver-btn {
          position: fixed;
          right: 20px;
          bottom: 20px;
          width: 54px;
          height: 54px;
          border: none;
          border-radius: 50%;
          background: linear-gradient(135deg,#10a37f,#0b8f6e);
          color: #fff;
          cursor: pointer;
          z-index: 999999;
          box-shadow: 0 10px 24px rgba(16,163,127,.3);
          font-size: 20px;
          font-weight: 700;
          user-select: none;
        }

        #chatgpt-saver-panel {
          position: fixed;
          right: 20px;
          bottom: 86px;
          width: 340px;
          background: rgba(255,255,255,.97);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(0,0,0,.08);
          border-radius: 20px;
          box-shadow: 0 16px 40px rgba(0,0,0,.16);
          z-index: 999998;
          padding: 14px;
          display: none;
        }

        #chatgpt-saver-panel.show { display: block; }

        .cgs-head {
          display:flex;
          align-items:center;
          justify-content:space-between;
          margin-bottom:12px;
        }

        .cgs-title {
          font-size:15px;
          font-weight:700;
          color:#111827;
        }

        .cgs-status {
          font-size:12px;
          color:#4b5563;
          background:#f3f4f6;
          border-radius:999px;
          padding:4px 10px;
        }

        .cgs-line {
          height:1px;
          background:#e5e7eb;
          margin:12px 0;
        }

        .cgs-row {
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          margin:8px 0;
        }

        .cgs-label {
          font-size:13px;
          color:#111827;
          font-weight:600;
        }

        .cgs-muted {
          font-size:12px;
          color:#6b7280;
          line-height:1.6;
        }

        .cgs-pill {
          font-size:12px;
          color:#374151;
          background:#f3f4f6;
          border-radius:999px;
          padding:4px 8px;
        }

        .cgs-grid {
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:8px;
          margin-top:10px;
        }

        .cgs-btn {
          border:none;
          border-radius:12px;
          padding:10px 12px;
          background:#eef2ff;
          color:#111827;
          font-size:13px;
          font-weight:600;
          cursor:pointer;
          transition:.2s;
        }

        .cgs-btn:hover { transform: translateY(-1px); }

        .cgs-btn-primary {
          background:#10a37f;
          color:#fff;
        }

        .cgs-btn-secondary {
          background:#e5e7eb;
          color:#111827;
        }

        .cgs-format-wrap {
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:8px;
          margin-top:8px;
        }

        .cgs-format-item {
          display:flex;
          align-items:center;
          gap:8px;
          padding:10px 12px;
          border:1px solid #e5e7eb;
          border-radius:12px;
          background:#fafafa;
          font-size:13px;
          color:#111827;
          font-weight:600;
        }

        .cgs-format-item input {
          width:15px;
          height:15px;
        }

        #chatgpt-saver-toast {
          position: fixed;
          z-index: 1000000;
          max-width: min(80vw, 360px);
          padding: 10px 14px;
          border-radius: 12px;
          color: #fff;
          font-size: 13px;
          line-height: 1.4;
          white-space: pre-wrap;
          box-shadow: 0 12px 30px rgba(0,0,0,.18);
          opacity: 0;
          pointer-events: none;
          transition: opacity .2s ease, transform .2s ease;
          background: #1f2937;
        }

        #chatgpt-saver-toast.show {
          opacity: 1;
        }

        #chatgpt-saver-toast.success { background:#10a37f; }
        #chatgpt-saver-toast.error { background:#ef4444; }
        #chatgpt-saver-toast.info { background:#374151; }
        #chatgpt-saver-toast.saving { background:#3b82f6; }
        #chatgpt-saver-toast.skip { background:#6b7280; }

        .cgs-import-modal {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,.35);
          backdrop-filter: blur(4px);
          z-index: 1000001;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }

        .cgs-import-modal.show { display:flex; }

        .cgs-import-dialog {
          width:min(720px,92vw);
          background:#fff;
          border-radius:18px;
          box-shadow:0 20px 50px rgba(0,0,0,.22);
          overflow:hidden;
        }

        .cgs-import-head,
        .cgs-import-foot {
          padding:14px 16px;
          border-bottom:1px solid #e5e7eb;
          display:flex;
          align-items:center;
          justify-content:space-between;
        }

        .cgs-import-foot {
          border-bottom:none;
          border-top:1px solid #e5e7eb;
          gap:10px;
          justify-content:flex-end;
        }

        .cgs-import-body { padding:16px; }

        .cgs-import-title {
          font-size:16px;
          font-weight:700;
          color:#111827;
        }

        .cgs-icon-btn {
          border:none;
          background:#f3f4f6;
          border-radius:10px;
          width:34px;
          height:34px;
          cursor:pointer;
        }

        .cgs-import-hint {
          font-size:13px;
          color:#4b5563;
          line-height:1.7;
          margin-bottom:12px;
        }

        .cgs-import-actions { margin-bottom:12px; }

        .cgs-preview {
          margin:0;
          white-space:pre-wrap;
          background:#f8fafc;
          border:1px solid #e5e7eb;
          border-radius:12px;
          padding:14px;
          max-height:340px;
          overflow:auto;
          font-size:12px;
          line-height:1.65;
          color:#111827;
        }

        .cgs-check {
          display:flex;
          gap:6px;
          align-items:center;
          font-size:13px;
          color:#111827;
          margin-top:12px;
        }
      `);
    },

    createFloatingButton() {
      const btn = document.createElement('button');
      btn.id = 'chatgpt-saver-btn';
      btn.title = 'ChatGPT 对话保存助手';
      btn.textContent = '存';
      btn.onclick = () => {
        CONFIG.showPanel = !CONFIG.showPanel;
        GM_setValue('showPanel', CONFIG.showPanel);
        this.panel.classList.toggle('show', CONFIG.showPanel);
      };

      document.body.appendChild(btn);
      this.root = btn;
    },

    createToast() {
      const toast = document.createElement('div');
      toast.id = 'chatgpt-saver-toast';
      document.body.appendChild(toast);
      this.toast = toast;
    },

    showToast(message, type = 'info', duration = 3000) {
      if (!this.toast) return;
      if (this.toastTimer) clearTimeout(this.toastTimer);

      this.toast.textContent = message;
      this.toast.className = 'show ' + type;

      const btn = document.getElementById('chatgpt-saver-btn');
      if (btn) {
        const rect = btn.getBoundingClientRect();

        this.toast.style.left = 'auto';
        this.toast.style.right = 'auto';
        this.toast.style.bottom = 'auto';
        this.toast.style.top = 'auto';

        const toastHeight = 40;
        const gap = 10;

        if (rect.top > toastHeight + gap + 20) {
          this.toast.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
        } else {
          this.toast.style.top = (rect.bottom + gap) + 'px';
        }

        const btnCenterX = rect.left + rect.width / 2;
        this.toast.style.left = btnCenterX + 'px';
        this.toast.style.transform = 'translateX(-50%)';
      }

      if (duration > 0) {
        this.toastTimer = setTimeout(() => {
          this.toast.className = '';
        }, duration);
      }
    },

    hideToast() {
      if (this.toast) this.toast.className = '';
      if (this.toastTimer) {
        clearTimeout(this.toastTimer);
        this.toastTimer = null;
      }
    },

    createPanel() {
      const panel = document.createElement('div');
      panel.id = 'chatgpt-saver-panel';
      panel.classList.toggle('show', !!CONFIG.showPanel);

      panel.innerHTML = `
        <div class="cgs-head">
          <div class="cgs-title">ChatGPT 对话保存助手</div>
          <div class="cgs-status" id="cgs-status">初始化中</div>
        </div>

        <div class="cgs-row">
          <div class="cgs-label">保存位置</div>
          <div class="cgs-pill" id="cgs-save-mode">-</div>
        </div>

        <div class="cgs-muted" id="cgs-folder-name">当前使用浏览器下载目录</div>

        <div class="cgs-grid">
          <button class="cgs-btn cgs-btn-primary" id="cgs-pick-folder">选择文件夹</button>
          <button class="cgs-btn cgs-btn-secondary" id="cgs-reset-folder">改回下载</button>
        </div>

        <div class="cgs-line"></div>

        <div class="cgs-row">
          <div class="cgs-label">导出格式</div>
          <div class="cgs-pill">勾选即参与导出</div>
        </div>

        <div class="cgs-format-wrap">
          <label class="cgs-format-item"><input type="checkbox" id="cgs-format-html"> HTML</label>
          <label class="cgs-format-item"><input type="checkbox" id="cgs-format-md"> Markdown</label>
          <label class="cgs-format-item"><input type="checkbox" id="cgs-format-pdf"> PDF</label>
          <label class="cgs-format-item"><input type="checkbox" id="cgs-format-json"> JSON Context</label>
        </div>

        <div class="cgs-grid">
          <button class="cgs-btn cgs-btn-primary" id="cgs-export-selected">导出已勾选格式</button>
          <button class="cgs-btn cgs-btn-secondary" id="cgs-import-json">导入 JSON</button>
        </div>

        <div class="cgs-line"></div>

        <div class="cgs-muted">
          已恢复自动保存：检测到新对话或新回复完成后，会自动保存到你已授权的文件夹中。<br>
          若当前仍是浏览器下载模式，自动保存不会触发，避免频繁弹出下载。
        </div>
      `;

      document.body.appendChild(panel);
      this.panel = panel;
      this.status = panel.querySelector('#cgs-status');

      panel.querySelector('#cgs-format-html').checked = !!CONFIG.formats.html;
      panel.querySelector('#cgs-format-md').checked = !!CONFIG.formats.md;
      panel.querySelector('#cgs-format-pdf').checked = !!CONFIG.formats.pdf;
      panel.querySelector('#cgs-format-json').checked = !!CONFIG.formats.json;

      panel.querySelector('#cgs-format-html').onchange = (e) => this.updateFormat('html', e.target.checked);
      panel.querySelector('#cgs-format-md').onchange = (e) => this.updateFormat('md', e.target.checked);
      panel.querySelector('#cgs-format-pdf').onchange = (e) => this.updateFormat('pdf', e.target.checked);
      panel.querySelector('#cgs-format-json').onchange = (e) => this.updateFormat('json', e.target.checked);

      panel.querySelector('#cgs-pick-folder').onclick = () => this.handlePickFolder();
      panel.querySelector('#cgs-reset-folder').onclick = () => this.handleResetFolder();
      panel.querySelector('#cgs-export-selected').onclick = () => Exporter.exportNow(true);
      panel.querySelector('#cgs-import-json').onclick = () => ContextImporter.show();
    },

    updateFormat(key, checked) {
      CONFIG.formats[key] = checked;
      GM_setValue('formats', CONFIG.formats);
    },

    updateStatus(text) {
      if (this.status) {
        this.status.textContent = text || (CONFIG.saveMode === 'folder' ? '文件夹模式' : '下载模式');
      }

      const modeEl = this.panel?.querySelector('#cgs-save-mode');
      const folderNameEl = this.panel?.querySelector('#cgs-folder-name');

      if (modeEl) {
        modeEl.textContent = CONFIG.saveMode === 'folder' ? '保存到文件夹' : '浏览器下载';
      }

      if (folderNameEl) {
        folderNameEl.textContent = CONFIG.saveMode === 'folder'
          ? `当前文件夹：${GM_getValue('savedFolderName', savedFolderHandle?.name || '已选择')}`
          : '当前使用浏览器下载目录';
      }
    },

    async handlePickFolder() {
      try {
        await Utils.selectFolder();
        this.updateStatus('文件夹模式');
        this.showToast('✅ 已选择保存文件夹', 'success');
      } catch (error) {
        if (error?.name === 'AbortError') return;
        this.showToast(`❌ 选择文件夹失败：${error.message}`, 'error', 4000);
      }
    },

    async handleResetFolder() {
      savedFolderHandle = null;
      CONFIG.saveMode = 'download';
      GM_setValue('saveMode', 'download');
      await Utils.clearHandleFromDB();
      this.updateStatus('下载模式');
      this.showToast('✅ 已改回浏览器下载目录', 'success');
    },

    triggerSend() {
      const selectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="发送消息"]',
        'form button[type="submit"]'
      ];

      for (const selector of selectors) {
        const btn = document.querySelector(selector);
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    }
  };

  const Exporter = {
    async exportNow(forceExport = false) {
      try {
        const conversation = Parser.parseConversation();
        if (!conversation.messages.length) {
          alert('没有找到可导出的对话内容');
          return;
        }

        const selected = Object.entries(CONFIG.formats)
          .filter(([, enabled]) => enabled)
          .map(([key]) => key);

        if (!selected.length) {
          if (forceExport) {
            UI.showToast('❌ 请至少勾选一种导出格式', 'error', 3000);
          }
          return;
        }

        const title = conversation.title;
        const workspaceName = Parser.getWorkspaceName();
        const currentMessageCount = conversation.messages.length;

        if (!forceExport && CONFIG.autoSave) {
          if (CONFIG.saveMode !== 'folder' || !savedFolderHandle) {
            return;
          }

          const checkResult = await Utils.checkConversationNeedsUpdate(
            savedFolderHandle,
            workspaceName,
            title,
            currentMessageCount
          );

          if (!checkResult.needsUpdate) {
            return;
          }

          UI.showToast('💾 正在保存更新文件...', 'saving', 0);
        } else if (forceExport) {
          UI.showToast(`⏳ 正在导出：${selected.join(' / ').toUpperCase()}...`, 'info', 6000);
        }

        let htmlContent = null;
        let mdContent = null;
        let pdfBlob = null;
        let contextJson = null;

        if (CONFIG.formats.html) {
          htmlContent = HTMLExporter.export(conversation);
        }

        if (CONFIG.formats.md) {
          mdContent = MarkdownExporter.export(conversation);
        }

        if (CONFIG.formats.pdf) {
          pdfBlob = await PDFExporter.export(conversation);
        }

        if (CONFIG.formats.json) {
          contextJson = JSON.stringify(ContextExporter.build(conversation), null, 2);
        }

        if (!htmlContent && !mdContent && !pdfBlob && !contextJson) {
          UI.hideToast();
          return;
        }

        const safeTitle = Utils.sanitizeFileName(title);

        if (CONFIG.saveMode === 'folder' && savedFolderHandle) {
          const result = await Utils.saveConversationToFolder(
            savedFolderHandle,
            workspaceName,
            title,
            htmlContent,
            mdContent,
            pdfBlob,
            contextJson,
            CONFIG.formats,
            {
              version: '4.2.0-lite',
              title,
              workspace: workspaceName,
              messageCount: currentMessageCount,
              savedAt: new Date().toISOString(),
              url: conversation.url
            }
          );

          if (result.success) {
            UI.showToast('✅ 已经成功保存啦', 'success', 3000);
            const count = GM_getValue('savedCount', 0) + 1;
            GM_setValue('savedCount', count);
            return;
          }

          UI.showToast(`❌ 保存失败：${result.error}`, 'error', 4200);
          return;
        }

        if (forceExport) {
          if (htmlContent) Utils.downloadFile(htmlContent, `${safeTitle}.html`, 'text/html');
          if (mdContent) Utils.downloadFile(mdContent, `${safeTitle}.md`, 'text/markdown');
          if (pdfBlob) Utils.downloadFile(pdfBlob, `${safeTitle}.pdf`, 'application/pdf');
          if (contextJson) Utils.downloadFile(contextJson, `${safeTitle}.json`, 'application/json');
          UI.showToast('✅ 已经成功保存啦', 'success', 3000);
          const count = GM_getValue('savedCount', 0) + 1;
          GM_setValue('savedCount', count);
        }
      } catch (error) {
        console.error('[ChatGPT Saver Lite] 导出失败:', error);
        UI.showToast(`❌ 导出失败：${error.message}`, 'error', 4200);
      }
    }
  };

  const Observer = {
    observer: null,
    debounceTimer: null,
    previousHash: null,
    previousURL: null,
    isWatching: false,
    onCompleteCallback: null,
    retryCount: 0,
    maxRetries: 30,

    start(onComplete) {
      if (this.isWatching && this.observer) {
        return;
      }

      this.onCompleteCallback = onComplete;

      const currentURL = window.location.href;
      if (this.previousURL !== currentURL) {
        this.previousHash = null;
        this.previousURL = currentURL;
      }

      const mainEl = document.querySelector('main');
      if (!mainEl) {
        this.retryCount++;
        if (this.retryCount <= this.maxRetries) {
          setTimeout(() => this.start(onComplete), 1000);
        }
        return;
      }

      this.retryCount = 0;

      if (this.observer) {
        this.observer.disconnect();
      }

      this.observer = new MutationObserver(mutations => this.handleMutations(mutations));
      this.observer.observe(mainEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: false
      });

      this.isWatching = true;
      UI.updateStatus();
    },

    handleMutations(mutations) {
      const hasRelevantChange = mutations.some(m => {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (
                node.querySelector &&
                (
                  node.querySelector('[data-message-author-role]') ||
                  node.getAttribute?.('data-message-author-role') ||
                  node.classList?.contains('group/conversation-turn')
                )
              ) {
                return true;
              }
              if (node.closest && node.closest('[data-message-author-role]')) {
                return true;
              }
            }

            if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
              const parent = node.parentElement;
              if (parent && parent.closest && parent.closest('[data-message-author-role]')) {
                return true;
              }
            }
          }
        }
        return false;
      });

      if (!hasRelevantChange) return;

      if (this.debounceTimer) clearTimeout(this.debounceTimer);

      const isTyping = Parser.isGPTTyping();

      if (isTyping) {
        this.debounceTimer = setTimeout(() => this.checkForCompletion(), 500);
        return;
      }

      this.debounceTimer = setTimeout(() => this.checkForCompletion(), CONFIG.debounceDelay);
    },

    checkForCompletion() {
      const isTyping = Parser.isGPTTyping();

      if (isTyping) {
        this.debounceTimer = setTimeout(() => this.checkForCompletion(), 1000);
        return;
      }

      setTimeout(() => {
        if (Parser.isGPTTyping()) {
          this.debounceTimer = setTimeout(() => this.checkForCompletion(), 1000);
          return;
        }

        const currentHash = Parser.getContentHash();
        const messages = Parser.getMessageElements();

        if (currentHash === this.previousHash) {
          return;
        }
        if (messages.length < 2) {
          return;
        }

        this.previousHash = currentHash;

        if (this.onCompleteCallback) {
          this.onCompleteCallback();
        }
      }, 2000);
    },

    reset() {
      this.previousHash = null;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
    },

    stop() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.isWatching = false;
      this.retryCount = 0;
      UI.updateStatus();
    }
  };

  const autoSaveCallback = async () => {
    if (!CONFIG.autoSave) return;
    await Exporter.exportNow(false);
  };

  function startURLWatcher() {
    if (urlCheckInterval) return;

    urlCheckInterval = setInterval(() => {
      const currentURL = window.location.href;
      if (currentURL !== lastURL) {
        lastURL = currentURL;
        Observer.reset();

        if (!Observer.isWatching) {
          Observer.start(autoSaveCallback);
        }
      }
    }, 500);
  }

  function setupHistoryListener() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('locationchange'));
    });

    window.addEventListener('locationchange', () => {
      const currentURL = window.location.href;
      if (currentURL !== lastURL) {
        lastURL = currentURL;
        Observer.reset();
        if (!Observer.isWatching) {
          Observer.start(autoSaveCallback);
        }
      }
    });
  }

  async function init() {
    console.log('[ChatGPT Saver Lite] 脚本加载中...');
    UI.init();

    const restore = await Utils.tryRestoreAccess();
    if (restore.success) {
      UI.updateStatus('文件夹模式');
    } else {
      UI.updateStatus('下载模式');
    }

    UI.showToast('✅ ChatGPT 对话保存助手已加载', 'success', 1800);

    Observer.start(autoSaveCallback);
    startURLWatcher();
    setupHistoryListener();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
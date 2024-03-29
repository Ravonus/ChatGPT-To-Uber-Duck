// src/chatgpt-api.ts
import ExpiryMap from "expiry-map";
import pTimeout from "p-timeout";
import { v4 as uuidv4 } from "uuid";

// src/types.ts
var ChatGPTError = class extends Error {
};

// src/chatgpt-conversation.ts
var ChatGPTConversation = class {
  constructor(api, opts = {}) {
    this.conversationId = void 0;
    this.parentMessageId = void 0;
    this.api = api;
    this.conversationId = opts.conversationId;
    this.parentMessageId = opts.parentMessageId;
  }
  async sendMessage(message, opts = {}) {
    const { onConversationResponse, ...rest } = opts;
    return this.api.sendMessage(message, {
      ...rest,
      conversationId: this.conversationId,
      parentMessageId: this.parentMessageId,
      onConversationResponse: (response) => {
        var _a;
        if (response.conversation_id) {
          this.conversationId = response.conversation_id;
        }
        if ((_a = response.message) == null ? void 0 : _a.id) {
          this.parentMessageId = response.message.id;
        }
        if (onConversationResponse) {
          return onConversationResponse(response);
        }
      }
    });
  }
};

// src/fetch.ts
var fetch = globalThis.fetch;
if (typeof fetch !== "function") {
  throw new Error(
    "Invalid environment: global fetch not defined; `chatgpt` requires Node.js >= 18 at the moment due to Cloudflare protections"
  );
}

// src/fetch-sse.ts
import { createParser } from "eventsource-parser";

// src/stream-async-iterable.ts
async function* streamAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// src/fetch-sse.ts
async function fetchSSE(url, options) {
  const { onMessage, ...fetchOptions } = options;
  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    const msg = `ChatGPTAPI error ${res.status || res.statusText}`;
    const error = new ChatGPTError(msg);
    error.statusCode = res.status;
    error.statusText = res.statusText;
    error.response = res;
    throw error;
  }
  const parser = createParser((event) => {
    if (event.type === "event") {
      onMessage(event.data);
    }
  });
  if (!res.body.getReader) {
    const body = res.body;
    if (!body.on || !body.read) {
      throw new ChatGPTError('unsupported "fetch" implementation');
    }
    body.on("readable", () => {
      let chunk;
      while (null !== (chunk = body.read())) {
        parser.feed(chunk.toString());
      }
    });
  } else {
    for await (const chunk of streamAsyncIterable(res.body)) {
      const str = new TextDecoder().decode(chunk);
      parser.feed(str);
    }
  }
}

// src/utils.ts
import { remark } from "remark";
import stripMarkdown from "strip-markdown";
function markdownToText(markdown) {
  return remark().use(stripMarkdown).processSync(markdown ?? "").toString();
}

// src/chatgpt-api.ts
var KEY_ACCESS_TOKEN = "accessToken";
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36";
var ChatGPTAPI = class {
  constructor(opts) {
    this._user = null;
    const {
      sessionToken,
      clearanceToken,
      markdown = true,
      apiBaseUrl = "https://chat.openai.com/api",
      backendApiBaseUrl = "https://chat.openai.com/backend-api",
      userAgent = USER_AGENT,
      accessTokenTTL = 60 * 6e4,
      accessToken,
      headers,
      debug = false
    } = opts;
    this._sessionToken = sessionToken;
    this._clearanceToken = clearanceToken;
    this._markdown = !!markdown;
    this._debug = !!debug;
    this._apiBaseUrl = apiBaseUrl;
    this._backendApiBaseUrl = backendApiBaseUrl;
    this._userAgent = userAgent;
    this._headers = {
      "user-agent": this._userAgent,
      "x-openai-assistant-app-id": "",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://chat.openai.com",
      referer: "https://chat.openai.com/chat",
      "sec-ch-ua": '"Not?A_Brand";v="8", "Chromium";v="108", "Google Chrome";v="108"',
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...headers
    };
    this._accessTokenCache = new ExpiryMap(accessTokenTTL);
    if (accessToken) {
      this._accessTokenCache.set(KEY_ACCESS_TOKEN, accessToken);
    }
    if (!this._sessionToken) {
      throw new ChatGPTError("ChatGPT invalid session token");
    }
    if (!this._clearanceToken) {
      throw new ChatGPTError("ChatGPT invalid clearance token");
    }
  }
  get user() {
    return this._user;
  }
  get sessionToken() {
    return this._sessionToken;
  }
  get clearanceToken() {
    return this._clearanceToken;
  }
  get userAgent() {
    return this._userAgent;
  }
  async sendMessage(message, opts = {}) {
    const {
      conversationId,
      parentMessageId = uuidv4(),
      messageId = uuidv4(),
      action = "next",
      timeoutMs,
      onProgress,
      onConversationResponse
    } = opts;
    let { abortSignal } = opts;
    let abortController = null;
    if (timeoutMs && !abortSignal) {
      abortController = new AbortController();
      abortSignal = abortController.signal;
    }
    const accessToken = await this.refreshAccessToken();
    const body = {
      action,
      messages: [
        {
          id: messageId,
          role: "user",
          content: {
            content_type: "text",
            parts: [message]
          }
        }
      ],
      model: "text-davinci-002-render",
      parent_message_id: parentMessageId
    };
    if (conversationId) {
      body.conversation_id = conversationId;
    }
    let response = "";
    const responseP = new Promise((resolve, reject) => {
      const url = `${this._backendApiBaseUrl}/conversation`;
      const headers = {
        ...this._headers,
        Authorization: `Bearer ${accessToken}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Cookie: `cf_clearance=${this._clearanceToken}`
      };
      if (this._debug) {
        console.log("POST", url, { body, headers });
      }
      fetchSSE(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
        onMessage: (data) => {
          var _a, _b;
          if (data === "[DONE]") {
            return resolve(response);
          }
          try {
            const parsedData = JSON.parse(data);
            if (onConversationResponse) {
              onConversationResponse(parsedData);
            }
            const message2 = parsedData.message;
            if (message2) {
              let text = (_b = (_a = message2 == null ? void 0 : message2.content) == null ? void 0 : _a.parts) == null ? void 0 : _b[0];
              if (text) {
                if (!this._markdown) {
                  text = markdownToText(text);
                }
                response = text;
                if (onProgress) {
                  onProgress(text);
                }
              }
            }
          } catch (err) {
            console.warn("fetchSSE onMessage unexpected error", err);
            reject(err);
          }
        }
      }).catch((err) => {
        const errMessageL = err.toString().toLowerCase();
        if (response && (errMessageL === "error: typeerror: terminated" || errMessageL === "typeerror: terminated")) {
          return resolve(response);
        } else {
          return reject(err);
        }
      });
    });
    if (timeoutMs) {
      if (abortController) {
        ;
        responseP.cancel = () => {
          abortController.abort();
        };
      }
      return pTimeout(responseP, {
        milliseconds: timeoutMs,
        message: "ChatGPT timed out waiting for response"
      });
    } else {
      return responseP;
    }
  }
  async getIsAuthenticated() {
    try {
      void await this.refreshAccessToken();
      return true;
    } catch (err) {
      return false;
    }
  }
  async ensureAuth() {
    return await this.refreshAccessToken();
  }
  async refreshAccessToken() {
    const cachedAccessToken = this._accessTokenCache.get(KEY_ACCESS_TOKEN);
    if (cachedAccessToken) {
      return cachedAccessToken;
    }
    let response;
    try {
      const url = `${this._apiBaseUrl}/auth/session`;
      const headers = {
        ...this._headers,
        cookie: `cf_clearance=${this._clearanceToken}; __Secure-next-auth.session-token=${this._sessionToken}`,
        accept: "*/*"
      };
      if (this._debug) {
        console.log("GET", url, headers);
      }
      const res = await fetch(url, {
        headers
      }).then((r) => {
        response = r;
        if (!r.ok) {
          const error = new ChatGPTError(`${r.status} ${r.statusText}`);
          error.response = r;
          error.statusCode = r.status;
          error.statusText = r.statusText;
          throw error;
        }
        return r.json();
      });
      const accessToken = res == null ? void 0 : res.accessToken;
      if (!accessToken) {
        const error = new ChatGPTError("Unauthorized");
        error.response = response;
        error.statusCode = response == null ? void 0 : response.status;
        error.statusText = response == null ? void 0 : response.statusText;
        throw error;
      }
      const appError = res == null ? void 0 : res.error;
      if (appError) {
        if (appError === "RefreshAccessTokenError") {
          const error = new ChatGPTError("session token may have expired");
          error.response = response;
          error.statusCode = response == null ? void 0 : response.status;
          error.statusText = response == null ? void 0 : response.statusText;
          throw error;
        } else {
          const error = new ChatGPTError(appError);
          error.response = response;
          error.statusCode = response == null ? void 0 : response.status;
          error.statusText = response == null ? void 0 : response.statusText;
          throw error;
        }
      }
      if (res.user) {
        this._user = res.user;
      }
      this._accessTokenCache.set(KEY_ACCESS_TOKEN, accessToken);
      return accessToken;
    } catch (err) {
      if (this._debug) {
        console.error(err);
      }
      const error = new ChatGPTError(
        `ChatGPT failed to refresh auth token. ${err.toString()}`
      );
      error.response = response;
      error.statusCode = response == null ? void 0 : response.status;
      error.statusText = response == null ? void 0 : response.statusText;
      error.originalError = err;
      throw error;
    }
  }
  getConversation(opts = {}) {
    return new ChatGPTConversation(this, opts);
  }
};

// src/openai-auth.ts
import * as fs from "node:fs";
import * as os from "node:os";
import delay from "delay";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());
async function getOpenAIAuth({
  email,
  password,
  browser,
  timeoutMs = 2 * 60 * 1e3,
  isGoogleLogin = false
}) {
  var _a, _b;
  let page;
  let origBrowser = browser;
  try {
    if (!browser) {
      browser = await getBrowser();
    }
    const userAgent = await browser.userAgent();
    page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto("https://chat.openai.com/auth/login");
    await checkForChatGPTAtCapacity(page);
    await page.waitForSelector("#__next .btn-primary", { timeout: timeoutMs });
    await delay(1e3);
    if (email && password) {
      await Promise.all([
        page.click("#__next .btn-primary"),
        page.waitForNavigation({
          waitUntil: "networkidle0"
        })
      ]);
      let submitP;
      if (isGoogleLogin) {
        await page.click('button[data-provider="google"]');
        await page.waitForSelector('input[type="email"]');
        await page.type('input[type="email"]', email, { delay: 10 });
        await Promise.all([
          page.waitForNavigation(),
          await page.keyboard.press("Enter")
        ]);
        await page.waitForSelector('input[type="password"]', { visible: true });
        await page.type('input[type="password"]', password, { delay: 10 });
        submitP = page.keyboard.press("Enter");
      } else {
        await page.waitForSelector("#username");
        await page.type("#username", email, { delay: 10 });
        await page.click('button[type="submit"]');
        await page.waitForSelector("#password");
        await page.type("#password", password, { delay: 10 });
        submitP = page.click('button[type="submit"]');
      }
      await Promise.all([
        submitP,
        new Promise((resolve, reject) => {
          let resolved = false;
          async function waitForCapacityText() {
            if (resolved) {
              return;
            }
            try {
              await checkForChatGPTAtCapacity(page);
              if (!resolved) {
                setTimeout(waitForCapacityText, 500);
              }
            } catch (err) {
              if (!resolved) {
                resolved = true;
                return reject(err);
              }
            }
          }
          page.waitForNavigation({
            waitUntil: "networkidle0"
          }).then(() => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          }).catch((err) => {
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });
          setTimeout(waitForCapacityText, 500);
        })
      ]);
    }
    const pageCookies = await page.cookies();
    const cookies = pageCookies.reduce(
      (map, cookie) => ({ ...map, [cookie.name]: cookie }),
      {}
    );
    const authInfo = {
      userAgent,
      clearanceToken: (_a = cookies["cf_clearance"]) == null ? void 0 : _a.value,
      sessionToken: (_b = cookies["__Secure-next-auth.session-token"]) == null ? void 0 : _b.value,
      cookies
    };
    return authInfo;
  } catch (err) {
    console.error(err);
    throw err;
  } finally {
    if (origBrowser) {
      if (page) {
        await page.close();
      }
    } else if (browser) {
      await browser.close();
    }
    page = null;
    browser = null;
  }
}
async function getBrowser(launchOptions) {
  return puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--exclude-switches", "enable-automation"],
    ignoreHTTPSErrors: true,
    executablePath: defaultChromeExecutablePath(),
    ...launchOptions
  });
}
var defaultChromeExecutablePath = () => {
  switch (os.platform()) {
    case "win32":
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    default:
      const chromeExists = fs.existsSync("/usr/bin/google-chrome");
      return chromeExists ? "/usr/bin/google-chrome" : "/usr/bin/google-chrome-stable";
  }
};
async function checkForChatGPTAtCapacity(page) {
  let res;
  try {
    res = await page.$x("//div[contains(., 'ChatGPT is at capacity')]");
    console.log("capacity text", res);
  } catch (err) {
    console.warn(err.toString());
  }
  if (res == null ? void 0 : res.length) {
    const error = new ChatGPTError("ChatGPT is at capacity");
    error.statusCode = 503;
    throw error;
  }
}
export {
  ChatGPTAPI,
  ChatGPTConversation,
  ChatGPTError,
  defaultChromeExecutablePath,
  getBrowser,
  getOpenAIAuth,
  markdownToText
};
//# sourceMappingURL=index.js.map
/**
 * confluence-client.js
 *
 * Generic Confluence REST API client for creating/updating pages.
 * Handles authentication for both Atlassian Cloud and Server/Data Center.
 *
 * This is core infrastructure - domain-agnostic and reusable across projects.
 *
 * @module lib/confluence-client
 * @version 1.0.0
 */

import https from "https";
import fs from "fs";

export class ConfluenceClient {
  constructor({ baseUrl, username, apiToken, pat, type }) {
    if (!baseUrl) {
      throw new Error("Missing required Confluence credential: baseUrl");
    }

    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash

    // Detect type if not provided
    if (!type) {
      type = baseUrl.includes('atlassian.net') ? 'cloud' : 'server';
    }

    this.type = type;

    // Set API prefix based on type
    this.apiPrefix = type === 'cloud' ? '/wiki/rest/api' : '/rest/api';

    if (type === 'cloud') {
      if (!username || !apiToken) {
        throw new Error("Missing required Confluence credentials for Cloud: username, apiToken");
      }
      this.username = username;
      this.apiToken = apiToken;
      this.auth = Buffer.from(`${username}:${apiToken}`).toString("base64");
      this.authHeader = `Basic ${this.auth}`;
    } else {
      // Server/Data Center with PAT
      if (!pat) {
        throw new Error("Missing required Confluence credential for Server: pat");
      }
      this.pat = pat;
      this.authHeader = `Bearer ${pat}`;
    }
  }

  /**
   * Make authenticated HTTPS request to Confluence API
   */
  async request(method, endpoint, body = null) {
    const url = new URL(`${this.baseUrl}${endpoint}`);

    const options = {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else {
            // Handle authentication errors gracefully
            if (res.statusCode === 401) {
              console.error(`\n❌ Confluence authentication failed: Invalid or expired token`);
              console.error(`   Run: padd auth refresh confluence\n`);
              process.exit(1);
            }
            
            const error = new Error(`Confluence API error: ${res.statusCode} ${res.statusMessage}`);
            error.statusCode = res.statusCode;
            error.responseBody = data;
            reject(error);
          }
        });
      });

      req.on("error", reject);

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Create a new page in Confluence
   *
   * @param {Object} params
   * @param {string} params.spaceKey - Confluence space key (e.g., "VMLDEVHUB")
   * @param {string} params.title - Page title
   * @param {string} params.body - HTML content (Confluence storage format)
   * @param {string} params.parentId - Parent page ID (optional)
   * @param {string[]} params.labels - Array of label strings (optional)
   */
  async createPage({ spaceKey, title, body, parentId, labels = [] }) {
    const payload = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: {
        storage: {
          value: body,
          representation: "storage",
        },
      },
    };

    if (parentId) {
      payload.ancestors = [{ id: parentId }];
    }

    const page = await this.request("POST", `${this.apiPrefix}/content`, payload);

    // Add labels if provided
    if (labels.length > 0 && page.id) {
      await this.addLabels(page.id, labels);
    }

    return page;
  }

  /**
   * Update an existing page
   */
  async updatePage({ pageId, title, body, version }) {
    const payload = {
      type: "page",
      title,
      version: { number: version + 1 },
      body: {
        storage: {
          value: body,
          representation: "storage",
        },
      },
    };

    return this.request("PUT", `${this.apiPrefix}/content/${pageId}`, payload);
  }

  /**
   * Get page by ID
   */
  async getPage(pageId) {
    return this.request("GET", `${this.apiPrefix}/content/${pageId}?expand=body.storage,version`);
  }

  /**
   * Check if page exists by title and space
   */
  async findPageByTitle(spaceKey, title) {
    const encodedTitle = encodeURIComponent(title);
    const endpoint = `${this.apiPrefix}/content?spaceKey=${spaceKey}&title=${encodedTitle}&expand=version`;

    const response = await this.request("GET", endpoint);

    if (response.results && response.results.length > 0) {
      return response.results[0];
    }

    return null;
  }

  /**
   * Add labels to a page
   */
  async addLabels(pageId, labels) {
    const labelObjects = labels.map((name) => ({
      prefix: "global",
      name: name.toLowerCase().replace(/\s+/g, "-"),
    }));

    return this.request("POST", `${this.apiPrefix}/content/${pageId}/label`, labelObjects);
  }

  /**
   * Upload an attachment to a Confluence page
   * @param {string} pageId - The ID of the page to attach to
   * @param {string} filePath - Local filesystem path to the file
   * @param {string} fileName - Name to use for the attachment (optional, defaults to basename)
   * @returns {Promise<Object>} Attachment metadata from Confluence
   */
  async addAttachment(pageId, filePath, fileName = null) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const attachmentName = fileName || filePath.split("/").pop();
    const boundary = `----WebKitFormBoundary${Date.now()}`;

    // Build multipart/form-data body
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${attachmentName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileContent);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // Make request to attachment endpoint
    const endpoint = `${this.apiPrefix}/content/${pageId}/child/attachment`;
    const url = new URL(this.baseUrl + endpoint);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          "X-Atlassian-Token": "no-check",
          ...(this.type === "cloud"
            ? { Authorization: `Basic ${Buffer.from(`${this.username}:${this.apiToken}`).toString("base64")}` }
            : { Authorization: `Bearer ${this.pat}` }),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ success: true, raw: data });
            }
          } else {
            reject(new Error(`Confluence API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get attachments for a page
   * @param {string} pageId - The ID of the page
   * @returns {Promise<Array>} Array of attachments
   */
  async getAttachments(pageId) {
    const endpoint = `${this.apiPrefix}/content/${pageId}/child/attachment`;
    const response = await this.request("GET", endpoint);
    return response.results || [];
  }

  /**
   * Update an existing attachment
   * @param {string} pageId - The ID of the page
   * @param {string} attachmentId - The ID of the attachment to update
   * @param {string} filePath - Local filesystem path to the file
   * @param {string} fileName - Name to use for the attachment
   * @returns {Promise<Object>} Updated attachment metadata
   */
  async updateAttachment(pageId, attachmentId, filePath, fileName) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const boundary = `----WebKitFormBoundary${Date.now()}`;

    // Build multipart/form-data body
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileContent);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // Make request to update attachment endpoint
    const endpoint = `${this.apiPrefix}/content/${pageId}/child/attachment/${attachmentId}/data`;
    const url = new URL(this.baseUrl + endpoint);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
          "X-Atlassian-Token": "no-check",
          ...(this.type === "cloud"
            ? { Authorization: `Basic ${Buffer.from(`${this.username}:${this.apiToken}`).toString("base64")}` }
            : { Authorization: `Bearer ${this.pat}` }),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ success: true, raw: data });
            }
          } else {
            reject(new Error(`Confluence API error ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Get child pages of a parent page
   */
  async getChildPages(parentId) {
    const endpoint = `${this.apiPrefix}/content/${parentId}/child/page?expand=version`;
    const response = await this.request("GET", endpoint);
    return response.results || [];
  }

  /**
   * Find child page by title under a specific parent
   */
  async findChildPageByTitle(parentId, title) {
    const children = await this.getChildPages(parentId);
    return children.find(page => page.title === title) || null;
  }

  /**
   * Delete a page
   */
  async deletePage(pageId) {
    return this.request("DELETE", `${this.apiPrefix}/content/${pageId}`);
  }

  /**
   * Upsert (create or update) a page intelligently
   *
   * Logic:
   * - If pageId provided → get page and update it
   * - If parentId provided → search for child by title, update if exists, create if not
   * - If neither → search in space by title, update if exists, create as root page if not
   *
   * @param {Object} params
   * @param {string} params.spaceKey - Confluence space key
   * @param {string} params.title - Page title
   * @param {string} params.body - HTML content (Confluence storage format)
   * @param {string} [params.pageId] - Specific page ID to update
   * @param {string} [params.parentId] - Parent page ID (creates as child if provided)
   * @param {string[]} [params.labels] - Array of label strings
   * @returns {Object} Created or updated page object with metadata: { page, wasUpdated: boolean }
   */
  async upsertPage({ spaceKey, title, body, pageId, parentId, labels = [] }) {
    let existingPage = null;

    // Strategy 1: Direct page ID provided (try first, fallback to search if fails)
    if (pageId) {
      try {
        existingPage = await this.getPage(pageId);
      } catch (error) {
        console.warn(`⚠️  Page ID ${pageId} not found, falling back to search by title...`);
        // Fall through to Strategy 2/3
      }
    }

    // Strategy 2: Search by parent + title (fallback or primary if no pageId)
    if (!existingPage && parentId) {
      existingPage = await this.findChildPageByTitle(parentId, title);
    }

    // Strategy 3: Search in space by title (last resort)
    if (!existingPage && !parentId) {
      existingPage = await this.findPageByTitle(spaceKey, title);
    }

    // Update existing page
    if (existingPage) {
      const updated = await this.updatePage({
        pageId: existingPage.id,
        title,
        body,
        version: existingPage.version.number
      });

      // Update labels if provided
      if (labels.length > 0) {
        await this.addLabels(existingPage.id, labels);
      }

      return { page: updated, wasUpdated: true };
    }

    // Create new page
    const created = await this.createPage({
      spaceKey,
      title,
      body,
      parentId,
      labels
    });

    return { page: created, wasUpdated: false };
  }
}

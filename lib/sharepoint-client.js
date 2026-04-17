/**
 * sharepoint-client.js
 *
 * SharePoint/OneDrive REST API wrapper via Microsoft Graph.
 * Handles file operations: move, rename, copy, delete, create folders.
 */

import fetch from "node-fetch";

export class SharePointClient {
  constructor({ accessToken }) {
    if (!accessToken) {
      throw new Error("Missing required SharePoint credentials: accessToken");
    }

    this.accessToken = accessToken;
    this.baseUrl = "https://graph.microsoft.com/v1.0";
  }

  /**
   * Make authenticated request to Microsoft Graph API
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    // Handle async operations (202 Accepted)
    if (response.status === 202) {
      return {
        status: 202,
        location: response.headers.get("Location"),
        monitorUrl: response.headers.get("Location"),
      };
    }

    // Handle no content operations (204)
    if (response.status === 204) {
      return { status: 204, success: true };
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Graph API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  /**
   * Get file/folder by path
   */
  async getByPath(drivePath) {
    const encodedPath = encodeURIComponent(drivePath);
    return this.request(`/me/drive/root:/${encodedPath}`);
  }

  /**
   * Get file/folder by ID
   */
  async getById(itemId) {
    return this.request(`/me/drive/items/${itemId}`);
  }

  /**
   * List children of a folder
   */
  async listChildren(folderId) {
    return this.request(`/me/drive/items/${folderId}/children`);
  }

  /**
   * Search for files by query
   */
  async search(query) {
    const encodedQuery = encodeURIComponent(query);
    return this.request(`/me/drive/root/search(q='${encodedQuery}')`);
  }

  /**
   * Rename file/folder (in current location)
   */
  async rename(itemId, newName) {
    return this.request(`/me/drive/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName }),
    });
  }

  /**
   * Move file/folder to new parent
   */
  async move(itemId, newParentId, newName = null) {
    const body = {
      parentReference: { id: newParentId },
    };

    if (newName) {
      body.name = newName;
    }

    return this.request(`/me/drive/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Move file/folder in site drive
   */
  async moveSiteItem(siteId, itemId, newParentId, newName = null) {
    const body = {
      parentReference: { id: newParentId },
    };

    if (newName) {
      body.name = newName;
    }

    return this.request(`/sites/${siteId}/drive/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Copy file to destination
   */
  async copy(itemId, destinationParentId, newName) {
    const body = {
      parentReference: { id: destinationParentId },
      name: newName,
    };

    return this.request(`/me/drive/items/${itemId}/copy`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Delete file/folder
   */
  async delete(itemId) {
    return this.request(`/me/drive/items/${itemId}`, {
      method: "DELETE",
    });
  }

  /**
   * Create folder
   */
  async createFolder(parentId, folderName) {
    const body = {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    };

    return this.request(`/me/drive/items/${parentId}/children`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Create folder in site drive
   */
  async createSiteFolder(siteId, parentId, folderName) {
    const body = {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    };

    return this.request(`/sites/${siteId}/drive/items/${parentId}/children`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * List children of folder in site drive
   */
  async listSiteChildren(siteId, folderId) {
    return this.request(`/sites/${siteId}/drive/items/${folderId}/children`);
  }

  /**
   * Ensure folder exists (create if doesn't exist)
   */
  async ensureFolderExists(parentId, folderName) {
    try {
      // Try to create
      return await this.createFolder(parentId, folderName);
    } catch (error) {
      // If already exists, find and return it
      if (error.message.includes("409") || error.message.includes("conflict")) {
        const children = await this.listChildren(parentId);
        const existing = children.value.find(
          (item) => item.name === folderName && item.folder
        );

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  /**
   * Ensure folder exists in site drive (create if doesn't exist)
   */
  async ensureSiteFolderExists(siteId, parentId, folderName) {
    try {
      // Try to create
      return await this.createSiteFolder(siteId, parentId, folderName);
    } catch (error) {
      // If already exists, find and return it
      if (error.message.includes("409") || error.message.includes("conflict")) {
        const children = await this.listSiteChildren(siteId, parentId);
        const existing = children.value.find(
          (item) => item.name === folderName && item.folder
        );

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }

  /**
   * Get SharePoint site drive by site ID
   */
  async getSiteDrive(siteId) {
    return this.request(`/sites/${siteId}/drive`);
  }

  /**
   * Get item from SharePoint site drive by path
   */
  async getSiteItemByPath(siteId, drivePath) {
    const encodedPath = encodeURIComponent(drivePath);
    return this.request(`/sites/${siteId}/drive/root:/${encodedPath}`);
  }

  /**
   * Find item in folder by name
   */
  async findInFolder(folderId, itemName) {
    const children = await this.listChildren(folderId);
    return children.value.find((item) => item.name === itemName);
  }

  /**
   * Get listItem for a drive item (to access SharePoint metadata)
   */
  async getListItem(siteId, itemId) {
    return this.request(`/sites/${siteId}/drive/items/${itemId}/listItem`);
  }

  /**
   * Update listItem fields (SharePoint metadata like Title, etc.)
   */
  async updateListItemFields(siteId, listId, itemId, fields) {
    return this.request(`/sites/${siteId}/lists/${listId}/items/${itemId}/fields`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  /**
   * Update video metadata (Title and expiration)
   *
   * @param {string} siteId - SharePoint site ID
   * @param {string} itemId - Drive item ID
   * @param {Object} metadata - Metadata to update
   * @param {string} metadata.title - Video title (displayed in player)
   * @param {boolean} metadata.noExpiration - Set to true to remove expiration
   */
  async updateVideoMetadata(siteId, itemId, metadata) {
    try {
      const fieldsToUpdate = {};
      const results = { title: false, expiration: null };

      // Update Title field (the one shown in video player)
      if (metadata.title) {
        fieldsToUpdate.Title = metadata.title;
      }

      // For expiration, we need to check if the field exists first
      // Only try to update if explicitly requested
      if (metadata.noExpiration === true) {
        // Get current fields to check if ExpirationDate exists
        try {
          const listItem = await this.request(
            `/sites/${siteId}/drive/items/${itemId}/listItem?expand=fields`
          );

          if (listItem.fields && 'ExpirationDate' in listItem.fields) {
            fieldsToUpdate.ExpirationDate = null;
            results.expiration = 'removed';
          } else {
            results.expiration = 'not-set';
          }
        } catch (error) {
          results.expiration = 'check-failed';
        }
      }

      // Update the fields
      if (Object.keys(fieldsToUpdate).length > 0) {
        await this.request(
          `/sites/${siteId}/drive/items/${itemId}/listItem/fields`,
          {
            method: "PATCH",
            body: JSON.stringify(fieldsToUpdate),
          }
        );
        results.title = true;
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to update video metadata: ${error.message}`);
    }
  }

  /**
   * Explore drive structure to find Recordings folder
   */
  async findRecordingsFolder() {
    try {
      // Try root first
      const root = await this.request("/me/drive/root/children");

      // Check if Recordings exists directly in root
      const recordingsInRoot = root.value.find(
        (item) =>
          (item.name === "Recordings" || item.name === "Grabaciones") && item.folder
      );

      if (recordingsInRoot) {
        return recordingsInRoot.id;
      }

      // Look for Documents folder
      const docs = root.value.find(
        (item) =>
          item.folder &&
          (item.name === "Documents" || item.name === "Documentos") &&
          !item.name.startsWith("_")
      );

      if (!docs) {
        return null;
      }

      // Check for Recordings inside Documents
      const docsChildren = await this.listChildren(docs.id);
      const recordings = docsChildren.value.find(
        (item) =>
          (item.name === "Recordings" || item.name === "Grabaciones") && item.folder
      );

      return recordings ? recordings.id : null;
    } catch (error) {
      console.error(`Error finding Recordings folder: ${error.message}`);
      return null;
    }
  }

  /**
   * Resolve a SharePoint share link to get the actual file item
   * @param {string} shareUrl - The share link URL (e.g., https://...sharepoint.com/:v:/r/...)
   * @returns {Promise<Object>} The driveItem object
   */
  async resolveShareLink(shareUrl) {
    // Create base64url encoded share token
    // Format: u!{base64url(url)}
    const base64 = Buffer.from(shareUrl).toString("base64");
    const base64url = base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const shareToken = `u!${base64url}`;

    // Resolve the share link
    return this.request(`/shares/${shareToken}/driveItem`);
  }

  //=======================
  // Excel Operations
  //=======================

  /**
   * Get worksheet data from Excel file by item ID
   * @param {string} itemId - Drive item ID of the Excel file
   * @param {string} sheetName - Name of the worksheet
   * @returns {Promise<Array<Array>>} 2D array of cell values
   */
  async getExcelData(itemId, sheetName) {
    const encodedSheetName = encodeURIComponent(sheetName);
    const endpoint = `/me/drive/items/${itemId}/workbook/worksheets('${encodedSheetName}')/usedRange`;
    
    const response = await this.request(endpoint);
    return response.values;
  }

  /**
   * Get worksheet data from Excel file via sharing URL
   * @param {string} sharingUrl - SharePoint sharing URL
   * @param {string} sheetName - Name of the worksheet
   * @returns {Promise<Array<Array>>} 2D array of cell values
   */
  async getExcelDataFromSharingUrl(sharingUrl, sheetName) {
    // Resolve sharing URL to get item
    const item = await this.resolveShareLink(sharingUrl);
    
    // Extract drive and item IDs
    const driveId = item.parentReference.driveId;
    const itemId = item.id;
    
    // Get worksheet data using drive and item IDs
    const encodedSheetName = encodeURIComponent(sheetName);
    const endpoint = `/drives/${driveId}/items/${itemId}/workbook/worksheets('${encodedSheetName}')/usedRange`;
    
    const response = await this.request(endpoint);
    return response.values;
  }

  /**
   * List all worksheets in an Excel file
   * @param {string} itemId - Drive item ID of the Excel file
   * @returns {Promise<Array>} Array of worksheet objects with name, id, position
   */
  async listExcelWorksheets(itemId) {
    const endpoint = `/me/drive/items/${itemId}/workbook/worksheets`;
    const response = await this.request(endpoint);
    return response.value;
  }
}

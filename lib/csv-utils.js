/**
 * csv-utils.js
 *
 * CSV utilities for converting between arrays and CSV format.
 * Handles Excel date conversion, escaping, and proper CSV formatting.
 */

/**
 * Convert Excel date serial number to YYYY-MM-DD string
 * @param {number} excelDate - Excel date serial number (days since 1900-01-01)
 * @returns {string} ISO date string (YYYY-MM-DD)
 */
function excelDateToString(excelDate) {
  // Excel dates start from January 1, 1900
  // But Excel incorrectly treats 1900 as a leap year
  // Add days to base date (1899-12-30 to account for this)
  const baseDate = new Date(1899, 11, 30);
  const milliseconds = excelDate * 24 * 60 * 60 * 1000;
  const jsDate = new Date(baseDate.getTime() + milliseconds);
  
  // Return YYYY-MM-DD format
  const year = jsDate.getFullYear();
  const month = String(jsDate.getMonth() + 1).padStart(2, '0');
  const day = String(jsDate.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

/**
 * Escape and format a cell value for CSV
 * @param {*} cell - Cell value
 * @returns {string} Escaped and formatted cell value
 */
function formatCsvCell(cell) {
  // Handle null/undefined
  if (cell === null || cell === undefined) {
    return "";
  }

  // Check if it's an Excel date serial number
  // Excel dates are typically between 43000 (2017) and 60000 (2064)
  if (typeof cell === "number" && cell > 43000 && cell < 60000) {
    return excelDateToString(cell);
  }

  const cellStr = String(cell);

  // Escape quotes and wrap in quotes if contains comma, quote, or newline
  if (cellStr.includes(",") || cellStr.includes('"') || cellStr.includes("\n")) {
    return '"' + cellStr.replace(/"/g, '""') + '"';
  }

  return cellStr;
}

/**
 * Convert 2D array to CSV string
 * @param {Array<Array>} data - 2D array of values
 * @returns {string} CSV formatted string
 */
export function arrayToCsv(data) {
  if (!Array.isArray(data) || data.length === 0) {
    return "";
  }

  return data
    .map((row) => row.map(formatCsvCell).join(","))
    .join("\n");
}

/**
 * Parse CSV string to 2D array
 * Note: Basic implementation, does not handle all edge cases
 * @param {string} csv - CSV formatted string
 * @returns {Array<Array<string>>} 2D array of values
 */
export function csvToArray(csv) {
  if (!csv || typeof csv !== "string") {
    return [];
  }

  const lines = csv.trim().split("\n");
  const result = [];

  for (const line of lines) {
    const row = [];
    let cell = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"' && inQuotes && nextChar === '"') {
        // Escaped quote
        cell += '"';
        i++; // Skip next quote
      } else if (char === '"') {
        // Toggle quote mode
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        // End of cell
        row.push(cell);
        cell = "";
      } else {
        cell += char;
      }
    }

    // Add last cell
    row.push(cell);
    result.push(row);
  }

  return result;
}

/**
 * Convert CSV to array of objects using first row as headers
 * @param {string} csv - CSV formatted string
 * @returns {Array<Object>} Array of objects
 */
export function csvToObjects(csv) {
  const array = csvToArray(csv);
  
  if (array.length === 0) {
    return [];
  }

  const headers = array[0];
  const rows = array.slice(1);

  return rows.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] || "";
    });
    return obj;
  });
}

/**
 * Convert array of objects to CSV string
 * @param {Array<Object>} objects - Array of objects
 * @param {Array<string>} headers - Optional custom headers (defaults to object keys)
 * @returns {string} CSV formatted string
 */
export function objectsToCsv(objects, headers = null) {
  if (!Array.isArray(objects) || objects.length === 0) {
    return "";
  }

  // Use provided headers or extract from first object
  const csvHeaders = headers || Object.keys(objects[0]);

  // Create header row
  const headerRow = csvHeaders.map(formatCsvCell).join(",");

  // Create data rows
  const dataRows = objects.map(obj => 
    csvHeaders.map(header => formatCsvCell(obj[header])).join(",")
  );

  return [headerRow, ...dataRows].join("\n");
}

/**
 * config-discovery.js
 *
 * Helper to discover config.{domain}.json by walking up directory tree
 * Similar to how padd's loadAuth() discovers auth.enc.json
 * 
 * @module config-discovery
 */

import fs from "fs";
import path from "path";

/**
 * Find config.{domain}.json by walking up directory tree from current working directory
 * @param {string} domain - Domain name (e.g., 'talk', 'report', 'project')
 * @returns {Object} { configPath: string, domainRoot: string, config: Object }
 * @throws {Error} if config.{domain}.json not found
 */
export function findDomainConfig(domain) {
  if (!domain) {
    throw new Error("domain parameter is required (e.g., 'talk', 'report')");
  }

  let currentDir = process.cwd();
  const root = path.parse(currentDir).root;
  const configFileName = `config.${domain}.json`;

  while (currentDir !== root) {
    const configPath = path.join(currentDir, configFileName);

    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, "utf8");
      const config = JSON.parse(configData);

      return {
        configPath,
        domainRoot: currentDir,
        config,
      };
    }

    // Move up one directory
    currentDir = path.dirname(currentDir);
  }

  throw new Error(
    `${configFileName} not found. Please run this script from a ${domain} directory.`
  );
}

/**
 * Convenience function for talk domain (backward compatibility)
 * @returns {Object} { configPath: string, talkRoot: string, config: Object }
 */
export function findTalkConfig() {
  const result = findDomainConfig('talk');
  return {
    ...result,
    talkRoot: result.domainRoot
  };
}

/**
 * Get repository root by walking up from domain root
 * Looks for .git directory
 * @param {string} domainRoot - Path to domain directory
 * @returns {string} Repository root path
 * @throws {Error} if .git directory not found
 */
export function getRepoRoot(domainRoot) {
  let currentDir = domainRoot;
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const gitPath = path.join(currentDir, ".git");

    if (fs.existsSync(gitPath)) {
      return currentDir;
    }

    currentDir = path.dirname(currentDir);
  }

  throw new Error(".git directory not found. Cannot determine repository root.");
}

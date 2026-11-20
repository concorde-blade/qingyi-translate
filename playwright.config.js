import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'*.spec.js',timeout:30000,workers:1,reporter:'list',outputDir:'work/test-results'});

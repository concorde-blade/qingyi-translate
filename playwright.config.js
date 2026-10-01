import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'extension.spec.js',timeout:30000,workers:1,reporter:'list',outputDir:'work/test-results'});

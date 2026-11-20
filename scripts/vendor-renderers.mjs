import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
for(const name of ['katex','markdown-it'])await mkdir(`src/vendor/${name}`,{recursive:true});
await cp('node_modules/katex/dist/katex.mjs','src/vendor/katex/katex.mjs');
await cp('node_modules/katex/dist/katex.min.css','src/vendor/katex/katex.min.css');
await cp('node_modules/katex/dist/fonts','src/vendor/katex/fonts',{recursive:true});
await cp('node_modules/katex/LICENSE','src/vendor/katex/LICENSE');
await cp('node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs','src/vendor/markdown-it/markdown-it.mjs');
await cp('node_modules/markdown-it/LICENSE','src/vendor/markdown-it/LICENSE');
const licenses=[];
for(const name of ['markdown-it','mdurl','uc.micro','entities','linkify-it','punycode.js']) {
  const pkg=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));
  let license;for(const filename of ['LICENSE','LICENSE.txt','LICENSE-MIT.txt']){try{license=await readFile(`node_modules/${name}/${filename}`,'utf8');break;}catch{}}
  if(!license)throw new Error(`Missing license for ${name}`);
  licenses.push(`${name} ${pkg.version}\n${license}`);
}
await writeFile('src/vendor/markdown-it/THIRD-PARTY-LICENSES.txt',licenses.join('\n\n---\n\n'));
for(const name of ['katex','markdown-it']) {
  const pkg=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));
  await writeFile(`src/vendor/${name}/SOURCE.md`,`# ${name} ${pkg.version}\n\nOfficial npm distribution, pinned in package-lock.json. License: ${pkg.license}.\nRegenerate local browser assets with node scripts/vendor-renderers.mjs.\nNo CDN, remote scripts or runtime font downloads are used.\n`);
}

import {cp,mkdir,mkdtemp,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const out=path.resolve('outputs');
await mkdir(out,{recursive:true});
await mkdir('work',{recursive:true});
const staging=await mkdtemp(path.resolve('work/build-'));
try {
  const publicDir=path.join(staging,'qingyi-ustc');
  await cp('src',publicDir,{recursive:true});
  // Always remove any personal seed before building a distributable archive.
  await writeFile(path.join(publicDir,'local-settings.js'),'export const LOCAL_SETTINGS = null;\n');
  const manifest=JSON.parse(await readFile(path.join(publicDir,'manifest.json'),'utf8'));
  const publicZip=path.join(out,`qingyi-ustc-${manifest.version}.zip`);
  execFileSync('python3',['-c',`import pathlib,sys,zipfile
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:
 for f in sorted(p.rglob('*')):
  if f.is_file():z.write(f,'qingyi-ustc/'+str(f.relative_to(p)))`,publicDir,publicZip]);
  await cp(publicDir,path.join(out,'qingyi-ustc'),{recursive:true});
  console.log(`Built outputs/qingyi-ustc-${manifest.version}.zip (no embedded credentials).`);

  // Explicit opt-in only; the config and personal directory are ignored by Git.
  if(process.argv.includes('--personal')) {
    const privateSettings=JSON.parse(await readFile('work/private/ustc-settings.json','utf8'));
    privateSettings.concurrency=1;privateSettings.requestInterval=4000;
    const personalDir=path.join(out,'qingyi-ustc-personal');
    await cp(publicDir,personalDir,{recursive:true});await chmod(personalDir,0o700);
    const settingsFile=path.join(personalDir,'local-settings.js');
    await writeFile(settingsFile,'// Personal configuration. Do not share.\nexport const LOCAL_SETTINGS = '+JSON.stringify(privateSettings)+';\n',{mode:0o600});
    await chmod(settingsFile,0o600);
    manifest.name='清译 · USTC 本机版';manifest.host_permissions=['https://api.llm.ustc.edu.cn/*'];
    await writeFile(path.join(personalDir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    console.log('Updated private personal directory; do not upload or share it.');
  }
} finally {
  await rm(staging,{recursive:true,force:true});
}

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "spiderman-boundary-"));
try {
  writeFileSync(join(temp, "package.json"), '{"type":"module","private":true}');
  const modules = [
    "core",
    "contracts",
    "store-sqlite",
    "vault",
    "provider-whatsapp",
  ];
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...modules.map((name) =>
        resolve(
          "artifacts/packages/splitin-spiderman-" + name + "-0.1.0-alpha.2.tgz",
        ),
      ),
    ],
    { cwd: temp, stdio: "pipe", timeout: 120000 },
  );
  writeFileSync(
    join(temp, "test.mjs"),
    `import assert from 'node:assert/strict';import {Engine} from '@splitin/spiderman-core';import {SqliteStore} from '@splitin/spiderman-store-sqlite';import {EncryptedVault} from '@splitin/spiderman-vault';import {WhatsAppBusinessProvider} from '@splitin/spiderman-provider-whatsapp';
const store=new SqliteStore(':memory:');let engine,policy,sends=0,mode="normal";engine=new Engine(store,new EncryptedVault(store,Buffer.alloc(32,1))).register(new WhatsAppBusinessProvider('v99.0',async(url,init)=>{if(init?.method==='POST'){sends++;return Response.json(mode==='normal'?{messages:[{id:'synthetic'}]}:{});}return Response.json({id:'123'});}));
try{const c=await engine.connect('alice','whatsapp-business',{phoneNumberId:'123',accessToken:'synthetic'});policy=await engine.policy('alice',{connectionId:c.id,operations:['message.send'],recipients:['+12125550123'],resources:[],expiresAt:Date.now()+60000,maxActions:1});await engine.submit('alice',{connectionId:c.id,operation:'message.send',input:{recipient:'+12125550123',text:'synthetic'},idempotencyKey:'packaged-boundary'});const actualRef=(await engine.connection('alice',c.id)).credentialRef;const read=engine.vault.get.bind(engine.vault);let revoke=true;engine.vault.get=async(owner,ref)=>{const value=await read(owner,ref);if(revoke&&ref===actualRef){revoke=false;await engine.removePolicy(owner,policy.id);}return value;};const receipt=await engine.runOnce();assert.equal(receipt.state,'failed');assert.equal(receipt.error,'policy_revoked');assert.equal(sends,0);assert.equal(revoke,false);mode='missing';const second=await engine.submit('alice',{connectionId:c.id,operation:'message.send',input:{recipient:'+12125550123',text:'synthetic'},idempotencyKey:'packaged-receipt'});await engine.approve('alice',second.id,second.inputDigest);const uncertain=await engine.runOnce();assert.equal(uncertain.state,'unknown_outcome');assert.equal(uncertain.error,'send_receipt_missing');assert.equal(sends,1);}finally{await store.close();}console.log('Installed package copies preserve authorization and error semantics.');`,
  );
  execFileSync(process.execPath, ["test.mjs"], { cwd: temp, stdio: "inherit" });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

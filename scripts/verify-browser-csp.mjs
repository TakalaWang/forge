import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, process.env.CSP_OUTPUT_DIRECTORY ?? "output/playwright/csp-reliability");
await mkdir(output, { recursive: true });
const sources = [];
for (const name of ["clang", "go", "java", "javascript", "python", "rust"]) {
  const { browserSource } = await import(`../packages/toolchain-${name}/dist/index.js`);
  sources.push(browserSource("/toolchains/"));
}
const policy = "default-src 'self'; script-src 'self' 'nonce-csp-test' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self'";
const importMap = { imports: {
  "@wasm-oj/browser": "/packages/browser/dist/index.js",
  "@wasm-oj/core": "/packages/core/dist/index.js",
  "@wasm-oj/contracts": "/packages/contracts/dist/index.js",
  "es-module-lexer": "/node_modules/es-module-lexer/dist/lexer.js",
  "fflate": "/node_modules/fflate/esm/browser.js",
} };
const html = `<html><head><script type="importmap" nonce="csp-test">${JSON.stringify(importMap)}</script><script type="module" src="/bootstrap.js"></script></head><body>Strict CSP runtime verification</body></html>`;
const bootstrap = `import { createBrowserEngine, WASM_OJ_LIBCXX_PCH_HEADER } from '@wasm-oj/browser';
window.cspViolations = []; addEventListener('securitypolicyviolation', e => window.cspViolations.push({directive:e.effectiveDirective, blockedURI:e.blockedURI, source:e.sourceFile}));
try { new Function('return 1')(); window.evalBlocked = false; } catch { window.evalBlocked = true; }
window.header = WASM_OJ_LIBCXX_PCH_HEADER;
const NativeWorker = Worker; window.createdWorkers = [];
window.Worker = class extends NativeWorker { constructor(url, options) { super(url, options); window.createdWorkers.push({ name:options?.name, worker:this }); } };
window.killWorker = name => NativeWorker.prototype.terminate.call(window.createdWorkers.findLast(entry => entry.name === name).worker);
window.engine = await createBrowserEngine({ artifactCache:false, toolchains: ${JSON.stringify(sources)} });
window.ready = true;`;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", policy);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/" || pathname === "/bootstrap.js") {
    res.setHeader("Content-Type", pathname === "/" ? "text/html" : "text/javascript");
    res.end(pathname === "/" ? html : bootstrap); return;
  }
  const relative = pathname.startsWith("/toolchains/") ? `public${pathname}` : pathname.slice(1);
  const local = path.resolve(root, relative);
  if (!local.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(local);
    res.setHeader("Content-Type", /\.(?:js|mjs)$/.test(local) ? "text/javascript" : local.endsWith(".wasm") ? "application/wasm" : local.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Content-Length", info.size);
    createReadStream(local).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const extraCppHeaders = "any atomic bit cfenv codecvt cuchar format cinttypes clocale complex cstdarg ctime cwchar cwctype filesystem forward_list fstream initializer_list istream list locale memory_resource new numbers ostream ratio regex scoped_allocator source_location stdexcept streambuf system_error typeindex typeinfo valarray version".split(" ").sort();
const fixtures = [
  { language:"javascript", label:"js-syntax-runtime", source:'const = ;', input:"", runtimeError:"SyntaxError" },
  { language:"javascript", label:"js-dynamic-types", source:'let x=1;x="42";console.log(x);', input:"", expected:"42\n" },
  { language:"typescript", label:"ts-require", source:'const fs=require("node:fs");console.log(Number(fs.readFileSync(0,"utf8"))+1);', input:"41", expected:"42\n" },
  { language:"typescript", label:"ts-top-level-await-ce", compileError:true, source:'import {createInterface} from "node:readline"; const lines=createInterface({input:process.stdin}); for await (const line of lines) {console.log(Number(line)+1)}', input:"41", expected:"42\n" },
  { language:"javascript", label:"esm-await", source:'const fs=await import("node:fs"); const n=Number(fs.readFileSync(0,"utf8")); console.log(await Promise.resolve(n+1));', input:"41", expected:"42\n" },
  { language:"javascript", label:"esm-rejection", source:'await Promise.reject(new Error("top-level-failure"));', input:"", runtimeError:"top-level-failure" },
  { language:"javascript", label:"esm-pending", source:'await new Promise(()=>{});', input:"", runtimeError:"Unsettled top-level await" },
  { language:"javascript", label:"node-stdio", source:'import fs from "fs"; const b=fs.readFileSync(0); process.stdout.write(b); process.stdout.write(Buffer.from("QQBC","base64"));', input:"終\0😀", expected:"終\0😀A\0B" },
  { language:"typescript", label:"node-stdio", source:'import fs from "node:fs"; const b=Buffer.alloc(3); fs.readSync(0,b,1,2,null); process.stdout.write(JSON.stringify([b.toString("hex"),fs.readFileSync(0,"utf8")]));', input:"éABC", expected:'["00c3a9","ABC"]' },
  { language:"javascript", label:"node-readline", source:'import readline from "node:readline"; const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on("line",line=>process.stdout.write(JSON.stringify(line))); rl.on("close",()=>process.stdout.write("closed"));', input:"a\r\nb\rc\n\n終", expected:'"a""b""c""""終"closed' },
  { language:"typescript", label:"node-readline", source:'import {createInterface} from "readline"; (async()=>{for await (const line of createInterface({input:process.stdin})) process.stdout.write(line+"!");})();', input:"a\n終", expected:"a!終!" },
  { language:"javascript", label:"node-pipe", source:'process.stdin.pipe(process.stdout);', input:"終\0😀", expected:"終\0😀" },
  { language:"javascript", label:"node-async-error", source:'process.stdin.on("data",()=>{throw new Error("async-stdio-failure")});', input:"x", runtimeError:"async-stdio-failure" },
  { language:"typescript", label:"node-async-error", source:'Promise.reject(new Error("unhandled-test-failure"));', input:"", runtimeError:"unhandled-test-failure" },
  { language:"javascript", label:"node-handled-error", source:'const p=Promise.reject(new Error("handled")); Promise.resolve().then(()=>p.catch(()=>process.stdout.write("caught")));', input:"", expected:"caught" },
  { language:"javascript", label:"std-nul", source:'import std from "std"; std.out.puts("a\\0終");', input:"", expected:"a\0終" },
  { language:"typescript", label:"node-unsupported", source:'import { unlinkSync } from "node:fs"; unlinkSync("x");', input:"", compileError:true },
  { language:"c", label:"stdio", source:'#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}', input:"20 22\n", expected:"42\n" },
  { language:"cpp", label:"bits-whitespace-and-raw-string", source:'# include<bits/stdc++.h>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n"<<R"raw(#include <bits/stdc++.h>)raw"<<"\\n";}', input:"20 22\n", expected:"42\n#include <bits/stdc++.h>\n" },
  { language:"cpp", label:"bits-list", source:'# include<bits/stdc++.h>\nint main(){std::list<int> x{20,22};std::cout<<x.front()+x.back()<<"\\n";}', input:"", expected:"42\n" },
  { language:"python", label:"input-no-newline", source:'a,b=map(int,input().split())\nprint(a+b)', input:"20 22", expected:"42\n" },
  { language:"javascript", label:"quickjs-stdin", source:'import * as std from "std"; const [a,b]=std.in.readAsString().trim().split(/\\s+/).map(Number); std.out.puts(String(a+b)+"\\n");', input:"20 22\n", expected:"42\n" },
  { language:"typescript", label:"quickjs-stdin", source:'import * as std from "std"; const values: number[]=std.in.readAsString().trim().split(/\\s+/).map(Number); std.out.puts(String(values[0]+values[1])+"\\n");', input:"20 22\n", expected:"42\n" },
  { language:"javascript", label:"node-fs", source:'import * as fs from "node:fs"; const [a,b]=fs.readFileSync(0,"utf8").trim().split(/\\s+/).map(Number); console.log(a+b);', input:"20 22\n", expected:"42\n" },
  { language:"typescript", label:"node-fs", source:'import * as fs from "node:fs"; const values: number[]=fs.readFileSync(0,"utf8").trim().split(/\\s+/).map(Number); console.log(values[0]+values[1]);', input:"20 22\n", expected:"42\n" },
  { language:"go", label:"fmt", source:'package main\nimport "fmt"\nfunc main(){var a,b int;fmt.Scan(&a,&b);fmt.Println(a+b)}', input:"20 22\n", expected:"42\n" },
  { language:"rust", label:"stdin", source:'use std::io::{self,Read};fn main(){let mut s=String::new();io::stdin().read_to_string(&mut s).unwrap();let mut it=s.split_whitespace().map(|x|x.parse::<i64>().unwrap());println!("{}",it.next().unwrap()+it.next().unwrap());}', input:"20 22\n", expected:"42\n" },
  { language:"java", label:"system-in", source:'public class Main { public static void main(String[] args) throws Exception { int a=System.in.read()-48; System.in.read(); int b=System.in.read()-48; System.out.println(a+b); } }', input:"2 4\n", expected:"6\n" },
  { language:"java", label:"scanner", source:'import java.util.Scanner; public class Main {public static void main(String[] args){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}', input:"20 22\n", expected:"42\n" },
  { language:"java", label:"syntax-error", source:'public class Main {public static void main(String[] args){ int x = ; }}', input:"", compileError:true },
];
fixtures.push(...JSON.parse(await readFile(path.join(root, "scripts/fixtures/java-client.json"), "utf8")));
fixtures.push(...JSON.parse(await readFile(path.join(root, "scripts/fixtures/python-memory.json"), "utf8")));
fixtures.push(
  { language:"c", label:"logical-clock-limit", source:'#include <stdio.h>\n#include <time.h>\nint main(){for(int i=0;i<10000;i++) clock();puts("42");}', input:"", termination:"logical-time-limit", resources:{logicalTimeLimitMs:1} },
  { language:"c", label:"cpu-work", source:'#include <stdio.h>\nint main(){volatile unsigned long long s=0;for(unsigned i=0;i<10000000;i++)s+=i;printf("%llu\\n",s);}', input:"", expected:"49999995000000\n" },
  { language:"python", label:"memory-16mb", source:'print(42)', input:"", expected:"42\n", resources:{memoryLimitBytes:16*1024*1024} },
  { language:"cpp", label:"empty-loop-budget", source:'int main(){for(;;);}', input:"", termination:"instruction-limit", resources:{wallTimeLimitMs:15000} },
);
const guessInteractor = { language:"cpp", source:'#include <cstdio>\nint main(int argc,char**argv){std::FILE*f=argc>1?std::fopen(argv[1],"r"):nullptr;long long secret,guess;int limit;if(!f||std::fscanf(f,"%lld %d",&secret,&limit)!=2)return 3;for(int round=0;round<limit;round++){if(std::scanf("%lld",&guess)!=1)return std::feof(stdin)?4:5;if(guess==secret){std::puts("=");std::fflush(stdout);return 0;}std::puts(guess<secret?"<":">");std::fflush(stdout);}return 1;}' };
const guessInput = secret => ({ args:["/judge/input.txt"], files:{"/judge/input.txt":`${secret} 25\n`} });
const guessCpp = { language:"cpp", source:'#include <iostream>\n#include <string>\nint main(){long long lo=1,hi=1<<20;std::string r;while(lo<=hi){long long mid=(lo+hi)/2;std::cout<<mid<<std::endl;if(!(std::cin>>r))return 2;if(r=="=")return 0;if(r=="<")lo=mid+1;else hi=mid-1;}return 1;}' };
const guessC = { language:"c", source:'#include <stdio.h>\nint main(void){long long lo=1,hi=1<<20;char r[4];while(lo<=hi){long long mid=(lo+hi)/2;printf("%lld\\n",mid);fflush(stdout);if(scanf("%3s",r)!=1)return 2;if(r[0]==\'=\')return 0;if(r[0]==\'<\')lo=mid+1;else hi=mid-1;}return 1;}' };
const readOne = { language:"c", source:'#include <stdio.h>\nint main(void){int x;return scanf("%d",&x)==1?0:1;}' };
const finalGuess = { language:"c", source:'#include <stdio.h>\nint main(void){puts("7");return 0;}' };
const secretInput = secret => ({ args:["/judge/input.txt"], files:{"/judge/input.txt":`${secret}\n`} });
const replyInteractor = (language, afterEof) => language === "c"
  ? { language, source:`#include <stdio.h>\nint main(int argc,char**argv){FILE*f=argc>1?fopen(argv[1],"r"):NULL;long long secret,guess;if(!f||fscanf(f,"%lld",&secret)!=1)return 2;if(scanf("%lld",&guess)!=1)return 3;${afterEof ? "while(getchar()!=EOF){}" : ""}puts(guess==secret?"correct":"wrong");if(fflush(stdout)!=0)return 4;${afterEof ? "" : "if(scanf(\"%lld\",&guess)!=EOF)return 5;"}return guess==secret?42:43;}` }
  : { language, source:`import sys\nsecret = int(open(sys.argv[1]).read())\nguess = int(input())\n${afterEof ? "sys.stdin.read()\n" : ""}print("correct" if guess == secret else "wrong", flush=True)\n${afterEof ? "" : "if sys.stdin.read().strip():\n    sys.exit(5)\n"}sys.exit(42 if guess == secret else 43)\n` };
const exited = (process, code) => process.termination === "exited" && process.code === code;
const guessed = result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.interactorToContestant.endsWith("=\n");
const interactiveFixtures = [
  { label:"interactive-ac-cpp", contestant:guessCpp, interactor:guessInteractor, options:{ interactor:guessInput(1) }, check:result => guessed(result) && result.contestantToInteractor.split("\n").length - 1 === 20 },
  { label:"interactive-ac-c", contestant:guessC, interactor:guessInteractor, options:{ interactor:guessInput(777777) }, check:guessed },
  { label:"interactive-wa-c", contestant:{ language:"c", source:'#include <stdio.h>\nint main(void){char r[4];for(;;){puts("7");fflush(stdout);if(scanf("%3s",r)!=1)return 0;}}' }, interactor:guessInteractor, options:{ interactor:guessInput(1) }, check:result => exited(result.interactor, 1) && exited(result.contestant, 0) && result.contestantToInteractor === "7\n".repeat(26) },
  { label:"interactive-python-contestant", contestant:{ language:"python", source:'lo, hi = 1, 1 << 20\nwhile lo <= hi:\n    mid = (lo + hi) // 2\n    print(mid, flush=True)\n    reply = input().strip()\n    if reply == "=":\n        break\n    if reply == "<":\n        lo = mid + 1\n    else:\n        hi = mid - 1\n' }, interactor:guessInteractor, options:{ interactor:guessInput(31337) }, check:guessed },
  { label:"interactive-python-interactor", contestant:guessC, interactor:{ language:"python", source:'import sys\nsecret, limit = map(int, open(sys.argv[1]).read().split())\nfor _ in range(limit):\n    try:\n        guess = int(input())\n    except EOFError:\n        sys.exit(4)\n    if guess == secret:\n        print("=", flush=True)\n        sys.exit(0)\n    print("<" if guess < secret else ">", flush=True)\nsys.exit(1)\n' }, options:{ interactor:guessInput(424242) }, check:guessed },
  { label:"interactive-poll-timeout", contestant:{ language:"c", source:'#include <poll.h>\n#include <stdio.h>\nint main(void){struct pollfd p={0,POLLIN,0};int r=poll(&p,1,1000);printf("%d\\n",r);fflush(stdout);char b[8];if(scanf("%7s",b)!=1)return 2;return b[0]==\'o\'?0:3;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){char b[8];if(scanf("%7s",b)!=1)return 2;puts("ok");fflush(stdout);return b[0]==\'0\'?0:1;}' }, options:{ contestant:{ resources:{ wallTimeLimitMs:10000 } }, interactor:{ resources:{ wallTimeLimitMs:10000 } } }, check:(result, elapsedMs) => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor === "0\n" && result.interactorToContestant === "ok\n" && result.contestant.metrics.logicalTimeNs >= 1e9 && elapsedMs < 5000 },
  { label:"interactive-poll-ready", contestant:{ language:"c", source:'#include <poll.h>\n#include <stdio.h>\nint main(void){puts("ping");fflush(stdout);struct pollfd p={0,POLLIN,0};while(poll(&p,1,0)==0){}if(!(p.revents&POLLIN))return 4;char b[8];if(scanf("%7s",b)!=1)return 2;return b[0]==\'p\'&&b[1]==\'o\'?0:3;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){char b[8];if(scanf("%7s",b)!=1)return 2;puts("pong");fflush(stdout);return 0;}' }, options:{ contestant:{ resources:{ wallTimeLimitMs:10000 } }, interactor:{ resources:{ wallTimeLimitMs:10000 } } }, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor === "ping\n" && result.interactorToContestant === "pong\n" },
  { label:"interactive-close-stdout", contestant:{ language:"c", source:'#include <stdio.h>\nint main(void){puts("42");if(fclose(stdout)!=0)return 4;char b[8];if(scanf("%7s",b)!=1)return 2;return b[0]==\'o\'&&b[1]==\'k\'?0:3;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){int x,n=0,s=0;while(scanf("%d",&x)==1){n++;s+=x;}int ok=n==1&&s==42;puts(ok?"ok":"no");fflush(stdout);return ok?0:1;}' }, options:{ contestant:{ resources:{ wallTimeLimitMs:10000 } }, interactor:{ resources:{ wallTimeLimitMs:10000 } } }, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor === "42\n" && result.interactorToContestant === "ok\n" },
  { label:"interactive-batch", contestant:{ language:"c", source:'#include <stdio.h>\nint main(void){long long x;for(int i=0;i<30000;i++){if(scanf("%lld",&x)!=1)return 2;printf("%lld\\n",2*x);}fflush(stdout);char b[8];if(scanf("%7s",b)!=1)return 3;return b[0]==\'o\'?0:4;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){for(int i=0;i<30000;i++)printf("%d\\n",1000000+i);fflush(stdout);for(int i=0;i<30000;i++){long long x;if(scanf("%lld",&x)!=1)return 2;if(x!=2LL*(1000000+i))return 1;}puts("ok");fflush(stdout);return 0;}' }, options:{ contestant:{ resources:{ wallTimeLimitMs:20000 } }, interactor:{ resources:{ wallTimeLimitMs:20000 } } }, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor.length === 240000 && result.interactorToContestant.length === 240003 && result.interactorToContestant.endsWith("ok\n") },
  { label:"interactive-poll-clockless", contestant:{ language:"c", source:'#include <poll.h>\n#include <stdio.h>\nint main(void){struct pollfd p[2]={{0,POLLIN,0},{1,POLLOUT,0}};if(poll(p,2,-1)<1||!(p[1].revents&POLLOUT))return 4;puts("ping");fflush(stdout);if(poll(p,1,-1)!=1||!(p[0].revents&POLLIN))return 5;char b[8];if(scanf("%7s",b)!=1)return 2;return b[0]==\'p\'&&b[1]==\'o\'?0:3;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){char b[8];if(scanf("%7s",b)!=1)return 2;puts("pong");fflush(stdout);return 0;}' }, options:{ contestant:{ resources:{ wallTimeLimitMs:10000 } }, interactor:{ resources:{ wallTimeLimitMs:10000 } } }, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor === "ping\n" && result.interactorToContestant === "pong\n" },
  { label:"interactive-instruction-limit", contestant:{ language:"cpp", source:'int main(){volatile unsigned long long spin=0;for(;;)spin=spin+1;}' }, interactor:guessInteractor, options:{ contestant:{ resources:{ wallTimeLimitMs:30000 } }, interactor:{ ...guessInput(1), resources:{ wallTimeLimitMs:30000 } } }, check:result => result.contestant.termination === "instruction-limit" && result.contestant.code === 137 && exited(result.interactor, 4) },
  { label:"interactive-empty-loop-budget", contestant:{ language:"cpp", source:'int main(){for(;;);}' }, interactor:readOne, options:{ contestant:{ resources:{ wallTimeLimitMs:15000 } }, interactor:{ resources:{ wallTimeLimitMs:15000 } } }, check:(result, elapsedMs) => result.contestant.termination === "instruction-limit" && result.contestant.code === 137 && exited(result.interactor, 1) && elapsedMs < 10000 },
  { label:"interactive-contestant-exits", contestant:{ language:"c", source:'int main(void){return 0;}' }, interactor:guessInteractor, options:{ interactor:guessInput(1) }, check:result => exited(result.contestant, 0) && exited(result.interactor, 4) && result.contestantToInteractor === "" },
  { label:"interactive-interactor-exits-eof", contestant:{ language:"c", source:'#include <stdio.h>\n#include <string.h>\nint main(void){char b[8];if(scanf("%7s",b)!=1||strcmp(b,"bye")!=0)return 2;return scanf("%7s",b)==EOF&&feof(stdin)?0:3;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){puts("bye");return 0;}' }, options:{}, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.interactorToContestant === "bye\n" },
  { label:"interactive-interactor-exits", contestant:{ language:"c", source:'#include <errno.h>\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(void){char b[8];if(scanf("%7s",b)!=1||strcmp(b,"bye")!=0)return 2;if(scanf("%7s",b)!=EOF)return 3;for(int i=0;i<3;i++)if(write(1,"x\\n",2)!=2)return errno==EPIPE?32:33;return 0;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){puts("bye");return 0;}' }, options:{}, check:result => exited(result.contestant, 0) && exited(result.interactor, 0) && result.contestantToInteractor === "x\nx\nx\n" && result.interactorToContestant === "bye\n" },
  ...[["c", true, 7], ["python", true, 8], ["c", false, 8], ["python", false, 7]].map(([language, afterEof, secret]) => ({ label:`interactive-reply-${afterEof ? "after-exit" : "race"}-${language}`, contestant:finalGuess, interactor:replyInteractor(language, afterEof), options:{ interactor:secretInput(secret) }, check:result => exited(result.contestant, 0) && exited(result.interactor, secret === 7 ? 42 : 43) && result.contestantToInteractor === "7\n" && result.interactorToContestant === (secret === 7 ? "correct\n" : "wrong\n") })),
  { label:"interactive-output-flood", contestant:{ language:"c", source:'#include <stdio.h>\nint main(void){while(fputs("flood\\n",stdout)>=0&&fflush(stdout)==0){}return 0;}' }, interactor:{ language:"c", source:'#include <stdio.h>\nint main(void){while(getchar()!=EOF){}return 0;}' }, options:{ contestant:{ resources:{ outputLimitBytes:65536 } } }, check:result => result.contestant.termination === "output-limit" && result.contestant.code === 137 && result.contestantToInteractor.length === 65536 && exited(result.interactor, 0) },
  { label:"interactive-wall-time", contestant:readOne, interactor:readOne, options:{ contestant:{ resources:{ wallTimeLimitMs:2000 } }, interactor:{ resources:{ wallTimeLimitMs:2000 } } }, check:(result, elapsedMs) => result.contestant.termination === "wall-time-limit" && result.interactor.termination === "wall-time-limit" && elapsedMs >= 2000 && elapsedMs < 15000 },
  { label:"interactive-cancel", contestant:readOne, interactor:readOne, options:{}, cancelAfterMs:1000, recovery:{ contestant:guessC, interactor:guessInteractor, options:{ interactor:guessInput(5) } }, check:(result, elapsedMs) => result.cancelled && elapsedMs < 10000 && guessed(result.recovery) },
];
const record = { policy, results:[], pageErrors:[], consoleErrors:[] };
let browser;
try {
  const browserType = {chromium, firefox, webkit}[process.env.WASM_OJ_BROWSER ?? "chromium"];
  if (!browserType) throw new Error("Unknown verification browser");
  browser = await browserType.launch({ headless:true });
  const context = await browser.newContext({ serviceWorkers:"block" });
  const page = await context.newPage();
  page.on("pageerror", e => record.pageErrors.push(e.message));
  page.on("console", message => { if(message.type()==="error") record.consoleErrors.push(message.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.ready, undefined, {timeout:120000});
  record.environment = await page.evaluate(() => ({evalBlocked:window.evalBlocked,crossOriginIsolated,userAgent:navigator.userAgent}));
  if (!record.environment.evalBlocked) throw new Error("CSP does not block dynamic JavaScript");
  console.log(JSON.stringify({ready:record.environment}));
  const selected = process.argv.slice(2);
  for (const fixture of fixtures.filter(fixture => selected.length === 0 || selected.includes(fixture.label))) {
    console.log(`START ${fixture.language}/${fixture.label}`);
    const result = await page.evaluate(async fixture => {
      const start = performance.now();
      const entry = fixture.entry ?? {c:"main.c",cpp:"main.cpp",python:"main.py",javascript:"main.js",typescript:"main.ts",go:"main.go",rust:"main.rs",java:"Main.java"}[fixture.language];
      const files = {[entry]:fixture.source, ...fixture.files};
      if (fixture.language === "cpp") files["src/bits/stdc++.h"] = window.header + (fixture.extraHeaders ?? []).map(name => `#include <${name}>\n`).join("");
      const timer = setTimeout(() => window.engine.cancel(), 180000);
      try {
        const build = await window.engine.compile({language:fixture.language,target:"wasip1",optimization:fixture.optimization??"release",entry,files,projectId:`csp-${fixture.language}-${fixture.label}`},{cache:false});
        const compilation = {success:build.success,stderr:build.stderr,stdout:build.stdout,diagnostics:build.diagnostics};
        if (!build.success || !build.artifact) return {language:fixture.language,label:fixture.label,compilation,pass:!!fixture.compileError,elapsedMs:Math.round(performance.now()-start)};
        const runs = [];
        for (let attempt = 0; attempt < (fixture.repeat ?? 1); attempt++) {
          const result = await window.engine.run(build.artifact,{stdin:fixture.input,determinism:fixture.determinism,resources:{logicalTimeLimitMs:5000,memoryLimitBytes:512*1024*1024,outputLimitBytes:16*1024*1024,wallTimeLimitMs:30000,...fixture.resources}});
          runs.push(result);
          if (result.termination !== "exited") break;
        }
        const run = runs.at(-1);
        return {language:fixture.language,label:fixture.label,compilation,run,runs,pass:!fixture.compileError&&runs.every(result => fixture.termination ? result.termination===fixture.termination : fixture.runtimeError ? result.code!==0&&result.stderr.includes(fixture.runtimeError) : result.termination==="exited"&&result.code===0&&result.stdout===fixture.expected),elapsedMs:Math.round(performance.now()-start)};
      } catch(error) { return {language:fixture.language,label:fixture.label,error:String(error),pass:false,elapsedMs:Math.round(performance.now()-start)}; }
      finally {clearTimeout(timer);}
    }, {...fixture, extraHeaders:extraCppHeaders});
    record.results.push(result);
    await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
    console.log(JSON.stringify({language:result.language,label:result.label,pass:result.pass,error:result.error,compiled:result.compilation?.success,code:result.run?.code,stdout:result.run?.stdout,stderr:result.compilation?.stderr||result.run?.stderr,elapsedMs:result.elapsedMs}));
  }
  if (selected.includes("execution-timing")) {
    const wasmPath = path.join(output, "slow-preparation.wasm");
    execFileSync("wat2wasm", ["-", "-o", wasmPath], {input:`(module (memory (export "memory") 1) (func (export "_start")) ${`(func ${"nop ".repeat(64)})`.repeat(3000)})`});
    record.executionTiming = await page.evaluate(async bytes => {
      const build = await window.engine.compile({language:"c",target:"wasip1",optimization:"release",entry:"main.c",files:{"main.c":"int main(){return 0;}"},projectId:"timing-seed"},{cache:false});
      if (!build.success || !build.artifact) throw new Error("Timing seed did not compile");
      const run = await window.engine.run({...build.artifact,bytes:new Uint8Array(bytes),size:bytes.length}, {resources:{wallTimeLimitMs:25}});
      return {run,pass:run.termination==="exited"&&run.code===0&&run.durationMs>25&&run.executionDurationMs<25};
    }, [...await readFile(wasmPath)]);
    console.log(JSON.stringify({executionTiming:record.executionTiming}));
  }
  const interactiveSelected = interactiveFixtures.filter(fixture => selected.length === 0 || selected.includes("interactive") || selected.includes(fixture.label));
  if (interactiveSelected.length > 0) record.interactive = [];
  for (const fixture of interactiveSelected) {
    console.log(`START ${fixture.label}`);
    const { check, ...input } = fixture;
    const outcome = await page.evaluate(async fixture => {
      const entries = { c:"main.c", cpp:"main.cpp", python:"main.py" };
      window.interactiveBuilds ??= new Map();
      const build = async program => {
        const key = `${program.language}\0${program.source}`;
        if (!window.interactiveBuilds.has(key)) {
          const entry = entries[program.language];
          const files = { [entry]:program.source };
          if (program.language === "cpp") files["src/bits/stdc++.h"] = window.header;
          const built = await window.engine.compile({ language:program.language, target:"wasip1", optimization:"release", entry, files, projectId:`csp-interactive-${window.interactiveBuilds.size}` }, { cache:false });
          if (!built.success || !built.artifact) throw new Error(`${program.language} build failed: ${built.stderr}`);
          window.interactiveBuilds.set(key, built.artifact);
        }
        return window.interactiveBuilds.get(key);
      };
      try {
        const contestant = await build(fixture.contestant);
        const interactor = await build(fixture.interactor);
        const start = performance.now();
        if (fixture.cancelAfterMs === undefined) {
          const result = await window.engine.interact(contestant, interactor, fixture.options);
          return { result, elapsedMs:Math.round(performance.now() - start) };
        }
        const pending = window.engine.interact(contestant, interactor, fixture.options);
        const timer = setTimeout(() => window.engine.cancel(), fixture.cancelAfterMs);
        let cancelled = false;
        let error;
        try { await pending; } catch (caught) { cancelled = true; error = String(caught); } finally { clearTimeout(timer); }
        const elapsedMs = Math.round(performance.now() - start);
        const recovery = await window.engine.interact(await build(fixture.recovery.contestant), await build(fixture.recovery.interactor), fixture.recovery.options);
        return { result:{ cancelled, error, recovery }, elapsedMs };
      } catch (error) { return { error:String(error) }; }
    }, input);
    const pass = !outcome.error && check(outcome.result, outcome.elapsedMs);
    const summary = outcome.result && !outcome.result.recovery ? {
      contestant:{ code:outcome.result.contestant.code, termination:outcome.result.contestant.termination, cost:outcome.result.contestant.metrics?.cost },
      interactor:{ code:outcome.result.interactor.code, termination:outcome.result.interactor.termination, cost:outcome.result.interactor.metrics?.cost },
      contestantToInteractorBytes:outcome.result.contestantToInteractor.length,
      interactorToContestantBytes:outcome.result.interactorToContestant.length,
    } : outcome.result;
    record.interactive.push({ label:fixture.label, pass, elapsedMs:outcome.elapsedMs, error:outcome.error, result:outcome.result });
    await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
    console.log(JSON.stringify({ label:fixture.label, pass, elapsedMs:outcome.elapsedMs, error:outcome.error, summary }));
  }
  if (selected.length === 0 || selected.includes("liveness")) {
    record.liveness = [];
    const sources = {
      readOne:{ language:"c", source:'#include <stdio.h>\nint main(void){int x;return scanf("%d",&x)==1?0:1;}' },
      yieldLoop:{ language:"c", source:'#include <sched.h>\nint main(void){for(;;)sched_yield();}' },
      computeLoop:{ language:"cpp", source:'int main(){volatile unsigned long long spin=0;for(;;)spin=spin+1;}' },
      guessContestant:guessC,
      guessInteractor,
    };
    const prepared = await page.evaluate(async sources => {
      window.livenessBuilds = {};
      for (const [name, { language, source }] of Object.entries(sources)) {
        const entry = language === "cpp" ? "main.cpp" : "main.c";
        const files = { [entry]:source };
        if (language === "cpp") files["src/bits/stdc++.h"] = window.header;
        const built = await window.engine.compile({ language, target:"wasip1", optimization:"release", entry, files, projectId:`csp-liveness-${name}` }, { cache:false });
        if (!built.success || !built.artifact) throw new Error(`liveness build ${name} failed: ${built.stderr}`);
        window.livenessBuilds[name] = built.artifact;
      }
      const summary = value => value.termination ?? (value.contestant ? `${value.contestant.termination}/${value.interactor.code}` : `compiled:${value.success}`);
      window.settle = promise => promise.then(value => ({ ok:true, summary:summary(value), stderr:value.stderr, at:performance.now() }), error => ({ ok:false, error:String(error), at:performance.now() }));
      const blocked = { contestant:{ resources:{ wallTimeLimitMs:20000 } }, interactor:{ resources:{ wallTimeLimitMs:20000 } } };
      window.livenessOperation = operation => {
        const builds = window.livenessBuilds;
        if (operation === "interact") return window.engine.interact(builds.readOne, builds.readOne, blocked);
        if (operation === "interact-compute") return window.engine.interact(builds.computeLoop, builds.readOne, { contestant:{ resources:{ instructionBudget:1e15, wallTimeLimitMs:20000 } }, interactor:{ resources:{ wallTimeLimitMs:20000 } } });
        if (operation === "run-yielding") return window.engine.run(builds.yieldLoop, { resources:{ instructionBudget:1e15, wallTimeLimitMs:20000 } });
        if (operation === "run-compute") return window.engine.run(builds.computeLoop, { resources:{ instructionBudget:1e15, wallTimeLimitMs:15000 } });
        if (operation === "compile-rust") return window.engine.compile({ language:"rust", target:"wasip1", optimization:"release", entry:"main.rs", files:{ "main.rs":'fn main(){println!("{}", 42);}' }, projectId:"csp-liveness-rust" }, { cache:false });
        return window.engine.compile({ language:"cpp", target:"wasip1", optimization:"release", entry:"main.cpp", files:{ "main.cpp":"#include <iostream>\n#include <regex>\nint main(){std::regex r(\"a+\");std::cout<<std::regex_match(\"aaa\",r)<<std::endl;}" }, projectId:"csp-liveness-compile" }, { cache:false });
      };
    }, sources).then(() => undefined, error => String(error));
    if (prepared) record.liveness.push({ label:"liveness-preparation", pass:false, error:prepared });
    const workerNamed = async name => {
      const nameOf = worker => Promise.race([worker.evaluate(() => self.name).catch(() => ""), new Promise(resolve => setTimeout(resolve, 3000, ""))]);
      for (let attempt = 0; attempt < 5; attempt++) {
        for (const worker of page.workers().reverse()) if (await nameOf(worker) === name) return worker;
        await page.waitForTimeout(500);
      }
      throw new Error(`The ${name} Worker is not visible to Playwright.`);
    };
    const nestedKiller = async (parentName, childName, settleMs = 0) => {
      const parent = await workerNamed(parentName);
      await parent.evaluate(() => {
        if (self.livenessWorkers) return;
        const Native = self.Worker; self.livenessWorkers = []; self.nativeTerminate = Native.prototype.terminate;
        self.Worker = class extends Native { constructor(url, options) { super(url, options); self.livenessWorkers.push({ name:options?.name, worker:this }); } };
      });
      return () => parent.evaluate(async ([name, settleMs]) => {
        for (let attempt = 0; attempt < 600 && !self.livenessWorkers.some(entry => entry.name === name); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
        await new Promise(resolve => setTimeout(resolve, settleMs));
        self.nativeTerminate.call(self.livenessWorkers.findLast(entry => entry.name === name).worker);
      }, [childName, settleMs]);
    };
    const pageKiller = name => () => page.evaluate(name => window.killWorker(name), name);
    const browserName = process.env.WASM_OJ_BROWSER ?? "chromium";
    const crashed = (outcome, killMs, limitMs) => /stopped without reporting an error/.test(outcome.ok ? outcome.stderr ?? "" : outcome.error) && killMs < limitMs;
    const livenessCases = [
      { label:"liveness-interactive-contestant", operation:"interact", killer:() => nestedKiller("wasm-oj-runner", "wasm-oj-interactive-contestant"), check:(outcome, killMs) => crashed(outcome, killMs, 3000) && outcome.error.includes("interactive contestant Worker") },
      { label:"liveness-interactive-interactor", operation:"interact", killer:() => nestedKiller("wasm-oj-runner", "wasm-oj-interactive-interactor"), check:(outcome, killMs) => crashed(outcome, killMs, 3000) && outcome.error.includes("interactive interactor Worker") },
      { label:"liveness-runner-interact", operation:"interact", killer:async () => pageKiller("wasm-oj-runner"), check:(outcome, killMs) => crashed(outcome, killMs, 3000) },
      { label:"liveness-runner-run-yielding", operation:"run-yielding", killer:async () => pageKiller("wasm-oj-runner"), check:(outcome, killMs) => crashed(outcome, killMs, 4000) },
      { label:"liveness-runner-run-compute", operation:"run-compute", killer:async () => pageKiller("wasm-oj-runner"), check:(outcome, killMs) => crashed(outcome, killMs, 4000) },
      { label:"liveness-interactive-compute", operation:"interact-compute", killer:() => nestedKiller("wasm-oj-runner", "wasm-oj-interactive-contestant"), check:(outcome, killMs) => crashed(outcome, killMs, 4000) && outcome.error.includes("interactive contestant Worker") },
      { label:"liveness-compiler", operation:"compile", killAfterMs:300, killer:async () => pageKiller("wasm-oj-compiler"), check:(outcome, killMs) => crashed(outcome, killMs, 4000) },
      { label:"liveness-compiler-stage", operation:"compile-rust", killAfterMs:0, killer:() => nestedKiller("wasm-oj-compiler", "wasm-oj-rustc-stage", 1000), check:(outcome, killMs) => crashed(outcome, killMs, 4000) },
    ];
    for (const fixture of prepared ? [] : livenessCases) {
      console.log(`START ${fixture.label}`);
      let outcome; let killMs; let error;
      try {
        const kill = await fixture.killer();
        await page.evaluate(operation => { window.livenessPending = window.settle(window.livenessOperation(operation)); }, fixture.operation);
        await page.waitForTimeout(fixture.killAfterMs ?? 1500);
        await kill();
        const killedAt = await page.evaluate(() => performance.now());
        outcome = await page.evaluate(() => window.livenessPending);
        killMs = Math.round(outcome.at - killedAt);
      } catch (caught) { error = String(caught); }
      const recovery = await page.evaluate(() => window.settle(window.engine.run(window.livenessBuilds.readOne, { stdin:"7\n" })));
      const pass = !error && fixture.check(outcome, killMs) && recovery.summary === "exited";
      record.liveness.push({ label:fixture.label, pass, killMs, outcome, error, recovery });
      await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
      console.log(JSON.stringify({ label:fixture.label, pass, killMs, error, outcome, recovery:recovery.summary ?? recovery.error }));
    }
    if (!prepared) {
      console.log("START liveness-no-false-positive");
      const steady = await page.evaluate(async () => {
        const outcomes = [];
        const builds = window.livenessBuilds;
        for (let index = 0; index < 20; index++) outcomes.push(await window.settle(window.engine.run(builds.readOne, { stdin:`${index}\n` })));
        for (let index = 0; index < 5; index++) outcomes.push(await window.settle(window.engine.interact(builds.guessContestant, builds.guessInteractor, { interactor:{ args:["/judge/input.txt"], files:{ "/judge/input.txt":`${index + 1} 25\n` } } })));
        outcomes.push(await window.settle(window.engine.compile({ language:"c", target:"wasip1", optimization:"release", entry:"main.c", files:{ "main.c":"int main(void){return 0;}" }, projectId:"csp-liveness-steady" }, { cache:false })));
        return outcomes.map(outcome => outcome.summary ?? outcome.error);
      });
      const steadyPass = steady.length === 26 && steady.slice(0, 20).every(value => value === "exited") && steady.slice(20, 25).every(value => value === "exited/0") && steady[25] === "compiled:true";
      record.liveness.push({ label:"liveness-no-false-positive", pass:steadyPass, outcomes:steady });
      console.log(JSON.stringify({ label:"liveness-no-false-positive", pass:steadyPass, outcomes:steady }));
    } else console.log(JSON.stringify({ label:"liveness-preparation", pass:false, error:prepared }));
  }
  record.capabilities = [];
  for (const invoke of [false, true]) {
    const wasmPath = path.join(output, `capability-${invoke}.wasm`);
    const source = `(module
      (import "wasix_64v1" "sock_open" (func $denied (param i32 i64 f32 f64) (result i64 i32)))
      (memory (export "memory") 1)
      (func (export "_start") ${invoke ? "i32.const 1 i64.const 2 f32.const 3 f64.const 4 call $denied drop drop" : ""}))`;
    execFileSync("wat2wasm", ["-", "-o", wasmPath], {input:source});
    const bytes = [...await readFile(wasmPath)];
    const response = await page.evaluate(async bytes => {
      const runtime = await import('/src/runner/generated/runtime-core.js');
      await runtime.default();
      return runtime.run_wasm_oj({
        wasm:new Uint8Array(bytes), args:[], env:{}, stdin:new Uint8Array(), files:{}, outputPaths:[], cwd:null, startupEntropyBytes:0,
        determinism:{randomSeed:7,realtimeEpochMs:946684800000,clockStepNs:1000000},
        resources:{instructionBudget:1000000,logicalTimeLimitMs:5000,memoryLimitBytes:131072,outputLimitBytes:1024,filesystemWriteLimitBytes:67108864,filesystemEntryLimit:4096},
      }, () => {});
    }, bytes);
    const pass = response.ok && (invoke
      ? response.result.termination === "trap" && response.result.trapMessage?.includes("wasix_64v1.sock_open")
      : response.result.code === 0 && response.result.termination === "exited");
    record.capabilities.push({invoke,pass,response});
    console.log(JSON.stringify({capabilityInvoke:invoke,pass,response}));
  }
  record.cspViolations = await page.evaluate(() => window.cspViolations);
  await page.evaluate(() => window.engine.dispose());
} catch(error) {record.failure=String(error);throw error;}
finally {
  await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
if(record.results.some(result=>!result.pass)||record.capabilities?.some(result=>!result.pass)||record.executionTiming?.pass===false||record.interactive?.some(result=>!result.pass)||record.liveness?.some(result=>!result.pass))process.exitCode=1;
console.log(`EVIDENCE ${path.join(output,"results.json")}`);

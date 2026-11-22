import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const katexDist=path.join(path.dirname(require.resolve('katex/package.json')),'dist');
export function mathBrowserAsset(name){
  if(name!=='katex.min.css'&&!/^fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/.test(name))return null;
  const file=path.join(katexDist,name);
  if(!fs.existsSync(file))return null;
  return {file,type:name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.woff2')?'font/woff2':name.endsWith('.woff')?'font/woff':'font/ttf'};
}

let bundle;
export function markdownBrowserBundle(){
  if(!bundle)bundle=buildSync({
    stdin:{contents:`import MarkdownIt from 'markdown-it';
      import cjkFriendly from 'markdown-it-cjk-friendly';
      import texmath from 'markdown-it-texmath';
      import katex from 'katex';
      import katexReplaceWithTex from 'katex/contrib/copy-tex/katex2tex.ts';
      window.mathSelectionSource = fragment => katexReplaceWithTex(fragment).textContent;
      window.markdownit = (...args) => new MarkdownIt(...args).use(cjkFriendly);
      window.markdownMath = md => {
        const render = (tex, displayMode) => katex.renderToString(tex, {
          displayMode, throwOnError:false, trust:false, strict:'ignore',
          maxExpand:1000, maxSize:20, output:'htmlAndMathml', macros:{}
        });
        md.use(texmath,{engine:{renderToString:(tex,options)=>render(tex,options.displayMode)},delimiters:['dollars','brackets']});
        md.inline.ruler.before('escape','math_display_brackets',(state,silent)=>{
          if(!state.src.startsWith('\\\\[',state.pos))return false;
          const end=state.src.indexOf('\\\\]',state.pos+2);
          if(end<0)return false;
          if(!silent){const token=state.push('math_inline_double','math',0);token.content=state.src.slice(state.pos+2,end);}
          state.pos=end+2;return true;
        });
        const escape=md.utils.escapeHtml;
        const safeRender=(tex,display)=>{
          try{return render(tex,display);}catch{return '<code class="math-error">'+escape(tex)+'</code>';}
        };
        md.renderer.rules.math_inline=(tokens,i)=>'<span class="math-inline">'+safeRender(tokens[i].content,false)+'</span>';
        md.renderer.rules.math_inline_double=(tokens,i)=>'<span class="math-display">'+safeRender(tokens[i].content,true)+'</span>';
        md.renderer.rules.math_block=(tokens,i)=>'<div class="math-display">'+safeRender(tokens[i].content,true)+'</div>\\n';
        md.renderer.rules.math_block_eqno=(tokens,i)=>'<div class="math-display math-numbered">'+safeRender(tokens[i].content,true)+'<span class="math-number">('+escape(tokens[i].info)+')</span></div>\\n';
      };`,
      resolveDir:fileURLToPath(new URL('..',import.meta.url)),sourcefile:'markdown-vendor.js'},
    bundle:true,write:false,minify:true,format:'iife',platform:'browser',target:'es2022',legalComments:'inline',
  }).outputFiles[0].text;
  return bundle;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {markdownBrowserBundle} from '../src/markdown-vendor.mjs';

const window={location:{origin:'http://127.0.0.1:8787'}};
vm.runInNewContext(markdownBrowserBundle(),{window});
vm.runInNewContext(fs.readFileSync(new URL('../web/markdown.js',import.meta.url),'utf8'),{window,URL});
const renderer=window.markdownRenderer;

test('the actual browser bundle exposes the renderer expected by the page',()=>{
  const context={};context.window=context;
  vm.runInNewContext(markdownBrowserBundle(),context);
  assert.equal(typeof context.markdownit,'function');
  vm.runInNewContext(fs.readFileSync(new URL('../web/markdown.js',import.meta.url),'utf8'),{window:{markdownit:context.markdownit,markdownMath:context.markdownMath,location:window.location},URL});
});

test('Chinese punctuation inside bold markers renders correctly next to Chinese or Latin text while code stays literal',()=>{
  const result=renderer.html('**结论：**支持改进。\n\n**论文主张：**LoFTR 使用上下文。\n\n**建议：**先做对照。\n\n`**结论：**源码`\n\n```text\n**论文主张：**源码\n```');
  assert.match(result,/<strong>结论：<\/strong>支持改进/);
  assert.match(result,/<strong>论文主张：<\/strong>LoFTR/);
  assert.match(result,/<strong>建议：<\/strong>先做对照/);
  assert.match(result,/<code>\*\*结论：\*\*源码<\/code>/);
  assert.match(result,/<code class="language-text">\*\*论文主张：\*\*源码/);
});

test('chat Markdown renders headings, emphasis, nested lists, GFM tables and escaped fenced code',()=>{
  const result=renderer.html('# 实验结论\n\n**加粗**、*强调*和 `pose_auc`。\n\n1. 控制变量\n   - 输入分辨率\n\n| 方法 | AUC |\n| --- | --- |\n| 基线 | 50.1 |\n\n```python\nprint("<result>")\n```');
  assert.match(result,/<h1>实验结论<\/h1>/);assert.match(result,/<strong>加粗<\/strong>/);
  assert.match(result,/<ol>[\s\S]*<ul>/);assert.match(result,/<div class="markdown-table-scroll"><table>/);
  assert.match(result,/<th>方法<\/th>/);assert.match(result,/<td>50\.1<\/td>/);
  assert.match(result,/<code class="language-python">print\(&quot;&lt;result&gt;&quot;\)/);
});

test('rendered model content cannot execute raw HTML or unsafe links, and external images do not auto-load',()=>{
  const result=renderer.html('<script>window.__md_attack=true</script>\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert%281%29)\n\n[encoded](javascript&#58;alert%281%29)\n\n[unsafe](data:text/html;base64,abc)\n\n![remote](https://example.invalid/tracker.png)\n\n[论文](https://arxiv.org/abs/2104.00680)');
  assert.doesNotMatch(result,/<script|<img|href="(?:javascript|data):/i);
  assert.match(result,/&lt;script&gt;/);assert.match(result,/rel="noopener noreferrer"/);
  assert.match(result,/<a href="https:\/\/arxiv\.org\/abs\/2104\.00680"/);
  assert.match(result,/<a href="https:\/\/example\.invalid\/tracker\.png"/);
});

test('streaming chunks split inside Markdown syntax settle into the same final rich text without duplicates',()=>{
  const chunks=['## 结','论\n\n**证','据**\n\n```py','thon\nprint("<ok>")\n','```'];
  const element={classList:{add(){}},innerHTML:''};let text='';
  for(const chunk of chunks){text+=chunk;renderer.renderInto(element,text);assert.doesNotMatch(element.innerHTML,/<ok>/);}
  assert.equal(element.innerHTML,renderer.html(chunks.join('')));
  assert.equal((element.innerHTML.match(/<h2>/g)??[]).length,1);
  assert.match(element.innerHTML,/<strong>证据<\/strong>/);
  assert.match(element.innerHTML,/<code class="language-python">/);
});

test('math supports dollar and LaTeX bracket delimiters, matrices, aligned blocks and numbered equations',()=>{
  for(const source of [String.raw`中文 $x_{t+1}=x_t+\Delta x_t$。`,String.raw`中文 \(g=\sigma(Wx)\)。`,String.raw`$$\frac{a}{b}+\sqrt{x}$$`,String.raw`\[\begin{bmatrix}a&b\\c&d\end{bmatrix}\]`,String.raw`解释：\[\sum_{i=1}^n i\]然后继续。`]){
    const html=renderer.html(source);assert.match(html,/class="katex"/);assert.match(html,/<math /);assert.doesNotMatch(html,/katex-error/);
  }
  const block=renderer.html(String.raw`公式：

\[
\begin{aligned}
\Delta x_t &= f_\theta(C,x_t)\\
x_{t+1} &= x_t+g_t\odot\Delta x_t
\end{aligned}
\]

$$E=mc^2$$ (1)`);
  assert.equal((block.match(/class="katex"/g)??[]).length,2);assert.match(block,/math-number">\(1\)/);assert.match(block,/math-display/);
});

test('math leaves code, escaped dollars, ordinary currency and unfinished streaming delimiters readable',()=>{
  const source=String.raw`价格 $20 和 $30。转义 \$x\$。`+'\n\n`$x^2$` 和 `\\(x\\)`\n\n```latex\n$$\\frac{a}{b}$$\n```';
  const result=renderer.html(source);assert.doesNotMatch(result,/class="katex"/);assert.match(result,/价格 \$20 和 \$30/);assert.match(result,/<code>\$x\^2\$<\/code>/);assert.match(result,/<code class="language-latex">\$\$\\frac/);
  const chunks=['独立公式：\n\n\\[\n\\fra','c{a_1}{b^2}','\n\\]'];
  const element={classList:{add(){}},innerHTML:''};let text='';
  for(const chunk of chunks){text+=chunk;assert.doesNotThrow(()=>renderer.renderInto(element,text));}
  assert.match(element.innerHTML,/class="katex"/);assert.equal(element.innerHTML,renderer.html(chunks.join('')));
  assert.doesNotThrow(()=>renderer.html(String.raw`错误 $\frac{a$ 后续消息照常显示。`));
  assert.match(renderer.html(String.raw`错误 $\frac{a$ 后续消息照常显示。`),/后续消息照常显示/);
});

test('math cannot inject links, images, HTML attributes or persist macros between messages',()=>{
  for(const source of [String.raw`$\href{javascript:alert(1)}{click}$`,String.raw`$\includegraphics{https://evil.invalid/tracker}$`,String.raw`$\htmlStyle{background:url(https://evil.invalid)}{x}$`,String.raw`$\htmlData{onmouseover=alert(1)}{x}$`,String.raw`$\text{<img src=x onerror=alert(1)>}$`]){
    const html=renderer.html(source);assert.doesNotMatch(html,/<a\b|<img\b|<script\b|\sonmouseover=|style="[^"]*url\(/i);
  }
  renderer.html(String.raw`$\gdef\testpersist{123456789}$`);
  assert.doesNotMatch(renderer.html(String.raw`$\testpersist$`),/>123456789</);
  assert.doesNotThrow(()=>renderer.html(String.raw`$\def\a{\a}\a$`));
});

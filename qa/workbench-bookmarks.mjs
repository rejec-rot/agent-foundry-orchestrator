// Real browser regression; callers supply an isolated read API and two tasks.
export async function verifyWorkbenchBookmarks({ browser, baseUrl, taskId, otherTaskId, check }) {
  const rendered = id => `Boolean(document.querySelector('#detail .work-head'))&&[...document.querySelectorAll('#detail .kv dd')].some(dd=>dd.textContent===${JSON.stringify(id)})`;
  await browser.send('Page.navigate', { url: `${baseUrl}/workbench.html?bookmark-test=initial#${taskId}` });
  await browser.waitFor(`location.search==='?bookmark-test=initial'&&Boolean(document.querySelector('#tasks [data-id="${otherTaskId}"]'))&&(${rendered(taskId)})`);
  check('带任务 ID 的交付链接自动显示该任务详情', await browser.evaluate(`document.querySelector('#tasks [data-id="${taskId}"]').getAttribute('aria-current')==='true'`));
  await browser.evaluate(`location.hash=${JSON.stringify(otherTaskId)}`);
  await browser.waitFor(rendered(otherTaskId));
  check('改变书签会同步详情和队列选中项', await browser.evaluate(`document.querySelector('#tasks [data-id="${otherTaskId}"]').getAttribute('aria-current')==='true'`));
  await browser.evaluate('window.demoBeforeReload=true');
  await browser.send('Page.reload'); await browser.waitFor(`!window.demoBeforeReload&&(${rendered(otherTaskId)})`);
  check('非 TASK 前缀的合法历史任务也可通过书签恢复', true);
  await browser.click(`#tasks [data-id="${taskId}"]`); await browser.waitFor(rendered(taskId));
  check('手动选中任务会更新地址，重开可定位', await browser.evaluate(`location.hash==='#'+${JSON.stringify(taskId)}`));
  await browser.send('Page.navigate', { url: `${baseUrl}/index.html?bookmark-test=legacy#${taskId}` });
  await browser.waitFor(`location.pathname==='/workbench.html'&&location.search==='?bookmark-test=legacy'&&(${rendered(taskId)})`);
  check('旧入口跳转后实际展示任务，而非只保留地址', true);
  await browser.evaluate("location.hash='TASK-missing-demo'");
  await browser.waitFor("document.querySelector('#detail .missing')?.textContent.includes('读取失败')");
  check('不存在的任务明确显示读取失败，不保留旧详情', await browser.evaluate("!document.querySelector('#detail .work-head')"));
  await browser.click(`#tasks [data-id="${otherTaskId}"]`); await browser.waitFor(rendered(otherTaskId));
  await browser.evaluate(`(() => {
    window.demoNativeFetch=window.fetch;window.demoInvalidRequests=[];
    window.fetch=(url,...args)=>{if(String(url).includes('/api/v2/tasks/'))window.demoInvalidRequests.push(String(url));return window.demoNativeFetch(url,...args);};
    location.hash='%E0%A4%A';
  })()`);
  await browser.waitFor("location.hash==='#%E0%A4%A'");
  await browser.evaluate("new Promise(done=>setTimeout(done,150))");
  await browser.evaluate("location.hash='..%2Foutside'");
  await browser.evaluate("new Promise(done=>setTimeout(done,150))");
  check('畸形编码和路径型书签不触发非法任务查询', await browser.evaluate(`!window.demoInvalidRequests.some(url=>url.includes('%E0')||url.includes('outside'))&&(${rendered(otherTaskId)})`));
  await browser.evaluate(`(() => {
    window.fetch=window.demoNativeFetch;
    const native=window.fetch;window.demoHoldOnce=true;window.demoOldReady=false;
    window.fetch=async(url,...args)=>{
      const response=await native(url,...args);
      if(String(url)===${JSON.stringify('/api/v2/tasks/' + taskId)}&&window.demoHoldOnce){
        window.demoHoldOnce=false;window.demoOldReady=true;
        await new Promise(done=>{window.demoReleaseOld=done;});
        const body=await response.json();body.model.blocks.task.value.goal='STALE DEMO RESULT';
        return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
      }
      return response;
    };
    location.hash=${JSON.stringify(taskId)};
  })()`);
  await browser.waitFor('window.demoOldReady');
  await browser.evaluate(`location.hash=${JSON.stringify(otherTaskId)}`); await browser.waitFor(rendered(otherTaskId));
  await browser.evaluate(`location.hash=${JSON.stringify(taskId)}`); await browser.waitFor(rendered(taskId));
  await browser.evaluate('window.demoReleaseOld();new Promise(done=>setTimeout(done,200))');
  check('A→B→A 时旧响应无法覆盖最新详情', await browser.evaluate(`(${rendered(taskId)})&&!document.getElementById('detail').textContent.includes('STALE DEMO RESULT')`));
  await browser.evaluate('window.fetch=window.demoNativeFetch');
}

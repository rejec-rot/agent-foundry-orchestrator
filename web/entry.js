// Keep historical /#TASK-* bookmarks working as collaboration becomes the default.
const destination = /^#TASK-/i.test(location.hash) ? '/workbench.html' : '/teams.html';
location.replace(destination + location.search + location.hash);

import { App } from '@modelcontextprotocol/ext-apps';
import { render } from './render.js';
import type { RenderCallbacks } from './types.js';
import type {
  MyPlatePayload,
  MyPlateErrorPayload,
  MyPlateScope,
} from '../../../../../lib/types.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

const app = new App({ name: 'Basecamp My Plate', version: '0.1.0' });

let lastScope: MyPlateScope = 'open';

const callbacks: RenderCallbacks = {
  onScopeChange: (next) => {
    lastScope = next;
    void app.callServerTool({ name: 'basecamp_my_plate', arguments: { scope: next } });
  },
  onCompleteTodo: (projectId, todoId) => {
    // Optimistic: remove the row immediately, restore on error.
    const row = root.querySelector(`.todo[data-todo-id="${todoId}"]`);
    const placeholder = row?.cloneNode(true) as HTMLElement | undefined;
    row?.remove();

    void app
      .callServerTool({
        name: 'basecamp_complete_todo',
        arguments: { project_id: projectId, todo_id: todoId },
      })
      .then((result) => {
        if ((result as { isError?: boolean }).isError && placeholder) {
          root.prepend(placeholder);
          toast(`Couldn't complete todo #${todoId}.`);
        }
      })
      .catch(() => {
        if (placeholder) root.prepend(placeholder);
        toast(`Couldn't complete todo #${todoId}.`);
      });
  },
};

app.ontoolresult = (result) => {
  const sc = (result as { structuredContent?: MyPlatePayload | MyPlateErrorPayload })
    .structuredContent;
  if (!sc) {
    render(
      root,
      {
        scope: lastScope,
        error: { message: 'Server returned no structured content.' },
        fetchedAt: new Date().toISOString(),
      },
      callbacks,
    );
    return;
  }
  lastScope = sc.scope;
  render(root, sc, callbacks);
};

window.addEventListener('error', (e) => {
  render(
    root,
    {
      scope: lastScope,
      error: { message: `UI error: ${e.message}` },
      fetchedAt: new Date().toISOString(),
    },
    callbacks,
  );
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = (e.reason as { message?: string } | undefined)?.message ?? String(e.reason);
  render(
    root,
    {
      scope: lastScope,
      error: { message: `UI error: ${reason}` },
      fetchedAt: new Date().toISOString(),
    },
    callbacks,
  );
});

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

void app.connect();

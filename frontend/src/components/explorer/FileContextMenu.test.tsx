import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { FileContextMenu, type MenuItem } from './FileContextMenu';

const item = (label: string, over: Partial<MenuItem> = {}): MenuItem =>
  ({ label, icon: <i data-testid={`icon-${label}`} />, onClick: vi.fn(), ...over });

afterEach(() => {
  // A test may shrink the viewport to exercise the clamp
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 768 });
});

describe('FileContextMenu - items', () => {
  it('renders every item with its icon, in a portal on the body', () => {
    const items = [item('Open'), item('Copy'), item('Delete', { danger: true })];
    const { container } = render(<FileContextMenu x={10} y={20} items={items} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Open', 'Copy', 'Delete']);
    expect(screen.getByTestId('icon-Open')).toBeInTheDocument();
  });

  it('a click runs the item and closes the menu, in that order', () => {
    const calls: string[] = [];
    const onClose = vi.fn(() => { calls.push('close'); });
    const items = [item('Open', { onClick: () => { calls.push('open'); } })];
    render(<FileContextMenu x={0} y={0} items={items} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(calls).toEqual(['close', 'open']);
    // The row's click stopped at the menu: the window listener did not close it a second time
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a disabled item cannot be clicked', () => {
    const items = [item('Rename', { disabled: true })];
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} items={items} onClose={onClose} />);
    const button = screen.getByRole('button', { name: 'Rename' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(items[0].onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('marks danger rows red and active rows cyan, plain rows neither', () => {
    render(<FileContextMenu x={0} y={0} onClose={() => {}} items={[
      item('Delete', { danger: true }), item('Show hidden files', { active: true }), item('Copy'),
    ]} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-red-400');
    expect(screen.getByRole('button', { name: 'Show hidden files' })).toHaveClass('text-cyan-400');
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass('text-slate-200');
    // Danger wins over active
    render(<FileContextMenu x={0} y={0} onClose={() => {}} items={[item('Both', { danger: true, active: true })]} />);
    expect(screen.getByRole('button', { name: 'Both' })).toHaveClass('text-red-400');
  });

  it('draws a separator above a separated item, but never above the first', () => {
    render(<FileContextMenu x={0} y={0} onClose={() => {}} items={[
      item('Open', { separated: true }), item('Copy', { separated: true }), item('Cut'),
    ]} />);
    const rules = document.querySelectorAll('.border-t');
    expect(rules).toHaveLength(1);
    expect(rules[0].nextElementSibling).toHaveTextContent('Copy');
  });
});

describe('FileContextMenu - dismissal', () => {
  it('closes on a click anywhere outside, a right-click, a resize and Escape', () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} items={[item('Open')]} onClose={onClose} />);
    fireEvent.click(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent(window, new Event('resize'));
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(window, { key: 'a' });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('a right-click on the menu itself neither closes it nor opens the browser menu', () => {
    const onClose = vi.fn();
    render(<FileContextMenu x={0} y={0} items={[item('Open')]} onClose={onClose} />);
    const menu = screen.getByRole('button', { name: 'Open' }).parentElement!.parentElement!;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(menu, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('drops its listeners on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<FileContextMenu x={0} y={0} items={[item('Open')]} onClose={onClose} />);
    unmount();
    fireEvent.click(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('FileContextMenu - position', () => {
  it('sits at the pointer when there is room', () => {
    render(<FileContextMenu x={100} y={200} items={[item('Open')]} onClose={() => {}} />);
    const menu = screen.getByRole('button', { name: 'Open' }).parentElement!.parentElement! as HTMLElement;
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('200px');
  });

  it('is clamped inside the viewport (its own size plus an 8px margin)', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 300 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 200 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 190, height: 50, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
    });
    render(<FileContextMenu x={250} y={190} items={[item('Open')]} onClose={() => {}} />);
    const menu = screen.getByRole('button', { name: 'Open' }).parentElement!.parentElement! as HTMLElement;
    expect(menu.style.left).toBe(`${300 - 190 - 8}px`);
    expect(menu.style.top).toBe(`${200 - 50 - 8}px`);
  });

  it('re-clamps when the pointer moves to a new spot', () => {
    const { rerender } = render(<FileContextMenu x={10} y={10} items={[item('Open')]} onClose={() => {}} />);
    act(() => { rerender(<FileContextMenu x={40} y={50} items={[item('Open')]} onClose={() => {}} />); });
    const menu = screen.getByRole('button', { name: 'Open' }).parentElement!.parentElement! as HTMLElement;
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
  });
});

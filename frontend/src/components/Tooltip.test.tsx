import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('shows its content in a portal while the trigger is hovered, and hides it on leave', () => {
    render(<Tooltip content="Queued · #2"><button>Trigger</button></Tooltip>);
    expect(screen.queryByText('Queued · #2')).toBeNull();

    fireEvent.mouseEnter(screen.getByText('Trigger').parentElement!);
    const tip = screen.getByText('Queued · #2');
    // Rendered at the body, not inside the trigger, so overflow:hidden parents can't clip it
    expect(tip.parentElement).toBe(document.body);

    fireEvent.mouseLeave(screen.getByText('Trigger').parentElement!);
    expect(screen.queryByText('Queued · #2')).toBeNull();
  });

  it('is placed below the trigger by default and above with position="top"', () => {
    const rect = { top: 100, bottom: 120, left: 40, width: 20, height: 20, right: 60, x: 40, y: 100, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);

    const below = render(<Tooltip content="below"><span>A</span></Tooltip>);
    fireEvent.mouseEnter(screen.getByText('A').parentElement!);
    expect(screen.getByText('below')).toHaveStyle({ top: '128px', left: '50px' });
    below.unmount();

    render(<Tooltip content="above" position="top"><span>B</span></Tooltip>);
    fireEvent.mouseEnter(screen.getByText('B').parentElement!);
    // 28px of assumed tooltip height plus an 8px gap above the trigger
    expect(screen.getByText('above')).toHaveStyle({ top: '64px', left: '50px' });
  });

  it('renders rich content, not just strings', () => {
    render(<Tooltip content={<><b>3 running</b>: 1.2 GB</>}><span>C</span></Tooltip>);
    fireEvent.mouseEnter(screen.getByText('C').parentElement!);
    expect(screen.getByText('3 running').tagName).toBe('B');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

const base = { title: 'Delete this run?', message: 'It cannot be undone.', onConfirm: vi.fn(), onCancel: vi.fn() };

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    render(<ConfirmDialog {...base} isOpen={false} />);
    expect(screen.queryByText('Delete this run?')).toBeNull();
  });

  it('shows the title and message in a portal with default button labels, and focuses Confirm', async () => {
    render(<ConfirmDialog {...base} isOpen />);
    expect(screen.getByRole('heading', { name: 'Delete this run?' })).toBeInTheDocument();
    expect(screen.getByText('It cannot be undone.')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // Enter should confirm straight away, so the confirm button takes focus
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  it('routes the buttons to their callbacks with custom labels', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...base} isOpen confirmText="Delete" cancelText="Keep" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels - only while open', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmDialog {...base} isOpen={false} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    rerender(<ConfirmDialog {...base} isOpen onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers the extra action only when both its label and handler are given', () => {
    const onExtraAction = vi.fn();
    const { rerender } = render(<ConfirmDialog {...base} isOpen extraActionText="Delete file too" />);
    expect(screen.queryByRole('button', { name: 'Delete file too' })).toBeNull();

    rerender(<ConfirmDialog {...base} isOpen extraActionText="Delete file too" onExtraAction={onExtraAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete file too' }));
    expect(onExtraAction).toHaveBeenCalledTimes(1);

    rerender(<ConfirmDialog {...base} isOpen extraActionText="Delete file too" onExtraAction={onExtraAction} extraActionDisabled />);
    expect(screen.getByRole('button', { name: 'Delete file too' })).toBeDisabled();
  });

  it('colours the confirm button by variant', () => {
    const { rerender } = render(<ConfirmDialog {...base} isOpen />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveClass('bg-red-600');
    rerender(<ConfirmDialog {...base} isOpen variant="warning" />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveClass('bg-yellow-600');
    rerender(<ConfirmDialog {...base} isOpen variant="info" />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveClass('bg-cyan-600');
  });
});

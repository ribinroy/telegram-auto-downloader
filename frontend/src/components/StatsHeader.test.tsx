import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsHeader } from './StatsHeader';
import { makeStats } from '../test/fixtures';

describe('StatsHeader', () => {
  it('shows the three totals, formatted', () => {
    render(<StatsHeader stats={makeStats({ total_downloaded: 3 * 1024 ** 3, pending_bytes: 512 * 1024, total_speed: 2048 })} />);
    expect(screen.getByText('Downloaded').nextElementSibling).toHaveTextContent('3.00 GB');
    expect(screen.getByText('Pending').nextElementSibling).toHaveTextContent('512.00 KB');
    expect(screen.getByText('Speed').nextElementSibling).toHaveTextContent('2.0 MB/s');
  });

  it('reads 0 B and a dash when idle', () => {
    render(<StatsHeader stats={makeStats()} />);
    expect(screen.getByText('Downloaded').nextElementSibling).toHaveTextContent('0 B');
    expect(screen.getByText('Speed').nextElementSibling).toHaveTextContent('-');
  });
});

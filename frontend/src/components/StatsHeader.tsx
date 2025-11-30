import { HardDrive, Clock, Zap } from 'lucide-react';
import type { Stats } from '../types';
import { formatBytes, formatSpeed } from '../utils/format';

interface StatsHeaderProps {
  stats: Stats;
}

export function StatsHeader({ stats }: StatsHeaderProps) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-green-500/20 rounded-lg">
            <HardDrive className="w-5 h-5 text-green-400" />
          </div>
          <div>
            <p className="text-slate-400 text-sm">Downloaded</p>
            <p className="text-white font-semibold">
              {formatBytes(stats.total_downloaded)}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-yellow-500/20 rounded-lg">
            <Clock className="w-5 h-5 text-yellow-400" />
          </div>
          <div>
            <p className="text-slate-400 text-sm">Pending</p>
            <p className="text-white font-semibold">
              {formatBytes(stats.pending_bytes)}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <Zap className="w-5 h-5 text-purple-400" />
          </div>
          <div>
            <p className="text-slate-400 text-sm">Speed</p>
            <p className="text-white font-semibold">
              {formatSpeed(stats.total_speed)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

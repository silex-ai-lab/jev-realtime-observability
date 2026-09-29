#!/usr/bin/env perl
# Time box for eval/finetune/finetune.sh on machines without GNU `timeout` (plan batch 2 D5).
#   perl eval/finetune/timebox.pl <seconds> <command> [args...]
# Exit codes follow GNU timeout: the command's own status; 128+N if a signal N killed it; 124 only when the
# deadline passed. At the deadline the command's process group gets TERM, then KILL after a 10 s grace.
use strict; use warnings;
use POSIX qw(:sys_wait_h);
my $secs = shift @ARGV;
die "usage: timebox.pl <seconds> <command> [args...]\n" unless defined $secs && $secs =~ /^\d+$/ && @ARGV;
my $grace = $ENV{TIMEBOX_GRACE} // 10;
my $pid = fork // die "fork: $!\n";
if (!$pid) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!\n"; }
setpgrp($pid, $pid);                      # also from the parent, so the group exists before any kill
my $timed = 0;
$SIG{ALRM} = sub {
  if (!$timed) { $timed = 1; kill 'TERM', -$pid; alarm $grace; }
  else { kill 'KILL', -$pid; }
};
alarm $secs;
my $r;
do { $r = waitpid($pid, 0) } while ($r == -1 && $!{EINTR});
my $status = $?;
alarm 0;
if ($timed) { kill 'KILL', -$pid; exit 124; }
exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);

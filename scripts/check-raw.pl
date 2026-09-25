#!/usr/bin/perl
# Raw interactive elements must be a primitive from ui.tsx, or opt out with
# data-custom="reason". Inputs/textareas/selects may instead use inputClass.
# Checkbox, radio, file and hidden inputs are native and exempt.
use strict; my $bad = 0;
for my $f (@ARGV) {
	next if $f =~ m{(^|/)ui\.tsx$};
	open my $h, '<', $f or die; local $/; my $s = <$h>;
	# Blank comments (keep newlines so line numbers hold).
	$s =~ s{/\*.*?\*/}{ (my $c = $&) =~ s/[^\n]/ /g; $c }gse;
	$s =~ s{^(\s*)//[^\n]*}{$1}gm;
	while ($s =~ /<(button|input|textarea|select)\b((?:[^>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)>/g) {
		my ($tag, $attrs) = ($1, $2);
		next if $attrs =~ /data-custom=/;
		next if $tag ne 'button' && $attrs =~ /inputClass/;
		next if $tag eq 'input' && $attrs =~ /type="(checkbox|radio|file|hidden)"/;
		my $line = 1 + (() = substr($s, 0, $-[0]) =~ /\n/g);
		print "$f:$line: raw <$tag>\n"; $bad = 1;
	}
}
exit $bad;

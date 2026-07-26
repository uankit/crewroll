import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import type { MemberRecord } from '@/data';
import { typography } from '@/ui/theme';

const COLORS = ['#386CFF', '#A15BDE', '#E56D56', '#1A9C86'];

export function AvatarStack({ members, max = 4 }: { members: readonly MemberRecord[]; max?: number }) {
  const visible = members.slice(0, max);
  const remainder = Math.max(0, members.length - visible.length);
  return (
    <View accessibilityLabel={`${members.length} trip members`} style={styles.stack}>
      {visible.map((member, index) => {
        const initial = member.displayName.trim().charAt(0).toUpperCase();
        return (
          <View key={member.id} style={[styles.avatar, { backgroundColor: COLORS[index % COLORS.length], marginLeft: index === 0 ? 0 : -10 }]}>
            {initial ? <Text style={styles.initial}>{initial}</Text> : <Ionicons name="person" size={15} color="#FFFFFF" />}
          </View>
        );
      })}
      {remainder > 0 ? (
        <View style={[styles.avatar, styles.more, { marginLeft: -10 }]}>
          <Text style={styles.moreText}>+{remainder}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: 'center', flexDirection: 'row' },
  avatar: {
    alignItems: 'center',
    borderColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: 2,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  initial: { color: '#FFFFFF', fontFamily: typography.bold, fontSize: 15 },
  more: { backgroundColor: '#10243B' },
  moreText: { color: '#FFFFFF', fontFamily: typography.bold, fontSize: 12 },
});

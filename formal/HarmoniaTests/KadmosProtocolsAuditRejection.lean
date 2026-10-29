import HarmoniaTests.KadmosAuditPolicy
import HarmoniaTests.KadmosProtocolsRejection.Unused
import HarmoniaTests.KadmosProtocolsRejection.Unsafe
namespace KadmosProtocolsRejection
axiom protocol : True
theorem indirect : True := protocol
/-- error: axiom audit rejected KadmosProtocolsRejection.indirect: KadmosProtocolsRejection.protocol -/
#guard_msgs in
#audit_declaration KadmosProtocolsRejection.indirect
/-- error: axiom audit rejected KadmosProtocolsEscapedTrap.unused: KadmosProtocolsEscapedTrap.unused -/
#guard_msgs in
#audit_module HarmoniaTests.KadmosProtocolsRejection.Unused
/-- error: axiom audit rejected KadmosProtocolsEscapedUnsafe.unused: KadmosProtocolsEscapedUnsafe.unused -/
#guard_msgs in
#audit_module HarmoniaTests.KadmosProtocolsRejection.Unsafe
end KadmosProtocolsRejection

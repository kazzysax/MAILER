// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Append-only on-chain log of Mailer inbox actions (handled / flagged / blocked).
/// No email content ever reaches this contract — only a hash of (userId:emailId), a status
/// code, the account the entry is for, and who actually signed it. Anyone may call
/// logStatus (gas cost is the natural spam deterrent, same as any public event log) —
/// this lets Mailer's server wallet log automatically (auto-sign) or a user's own
/// connected wallet log directly for itself (manual approval).
contract MailerLog {
    enum Status { Handled, Flagged, Blocked }

    event StatusLogged(
        bytes32 indexed emailHash,
        Status status,
        address indexed onBehalfOf,
        address indexed signer,
        uint256 timestamp
    );

    function logStatus(bytes32 emailHash, Status status, address onBehalfOf) external {
        emit StatusLogged(emailHash, status, onBehalfOf, msg.sender, block.timestamp);
    }
}

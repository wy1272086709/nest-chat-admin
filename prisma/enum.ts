// ===== 枚举定义 =====
export enum UserStatus {
    ACTIVE,
    INACTIVE,
    BLOCKED
}

export enum ArticleStatus {
    DRAFT,
    PUBLISHED,
    ARCHIVED
}

export enum ReviewStatus {
    PENDING,
    APPROVED,
    REJECTED
}


export enum MemberRole {
    OWNER,     // 群主
    MEMBER    // 普通成员
}

export enum MemberStatus {
    ACTIVE,    // 活跃成员
    LEFT,      // 已离开
    KICKED,    // 被踢出
    BANNED    // 被封禁
}

export enum MessageType {
    TEXT,      // 文本消息
    IMAGE     // 图片消息
}

export enum MessageStatus {
    SENT,      // 已发送
    DELIVERED, // 已送达
    READ      // 已读
}
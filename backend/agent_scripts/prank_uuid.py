import uuid

def generate_uuid() -> str:
    """
    生成一个随机的 UUID（通用唯一识别码）。
    
    每次调用都会生成一个全新的 UUID v4 随机值，
    返回格式为标准 36 字符 UUID 字符串，例如 "550e8400-e29b-41d4-a716-446655440000"。
    
    Returns:
        str: 随机 UUID 字符串
    """
    return str(uuid.uuid4())

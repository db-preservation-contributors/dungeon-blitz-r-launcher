const TAG_END: u16 = 0;
const TAG_SHOW_FRAME: u16 = 1;
const TAG_SET_BACKGROUND_COLOR: u16 = 9;
const TAG_DO_ACTION: u16 = 12;
const TAG_FILE_ATTRIBUTES: u16 = 69;
const ACTION_GET_URL: u8 = 0x83;
const ACTION_PUSH: u8 = 0x96;
const ACTION_SET_PROPERTY: u8 = 0x23;
const PROPERTY_QUALITY: f32 = 19.0;
pub const QUALITIES: [&str; 4] = ["LOW", "MEDIUM", "HIGH", "BEST"];

fn action(code: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![code];
    out.extend_from_slice(&(body.len() as u16).to_le_bytes());
    out.extend_from_slice(body);
    out
}

fn set_quality(quality: &str) -> Vec<u8> {
    let mut push = vec![0, 0, 1];
    push.extend_from_slice(&PROPERTY_QUALITY.to_le_bytes());
    push.push(0);
    push.extend_from_slice(quality.as_bytes());
    push.push(0);
    let mut out = action(ACTION_PUSH, &push);
    out.push(ACTION_SET_PROPERTY);
    out
}

fn tag(code: u16, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if body.len() < 0x3f {
        out.extend_from_slice(&((code << 6) | body.len() as u16).to_le_bytes());
    } else {
        out.extend_from_slice(&((code << 6) | 0x3f).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    }
    out.extend_from_slice(body);
    out
}

fn bit_length(value: i64) -> u32 {
    let v = value.unsigned_abs();
    if v == 0 { 1 } else { 64 - v.leading_zeros() }
}

pub fn rect(x_min: i64, x_max: i64, y_min: i64, y_max: i64) -> Vec<u8> {
    let values = [x_min, x_max, y_min, y_max];
    let bits = values.iter().map(|v| bit_length(*v) + 1).max().unwrap_or(1);
    let mut packed = format!("{bits:05b}");
    for value in values {
        let unsigned = if value < 0 { (1i64 << bits) + value } else { value };
        packed.push_str(&format!("{:0width$b}", unsigned, width = bits as usize));
    }
    while packed.len() % 8 != 0 {
        packed.push('0');
    }
    packed.as_bytes().chunks(8).map(|chunk| u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 2).unwrap()).collect()
}

pub fn build(url: &str, render: &str, quality: &str) -> Result<Vec<u8>, String> {
    let render_flag: u8 = match render {
        "" => 0,
        "direct" => 0x40,
        "gpu" => 0x20,
        other => return Err(format!("unknown render mode \"{other}\"")),
    };
    if !quality.is_empty() && !QUALITIES.contains(&quality) {
        return Err(format!("unknown quality \"{quality}\""));
    }
    if url.as_bytes().contains(&0) {
        return Err("the game URL cannot contain a NUL byte".into());
    }
    let (width, height, background) = (1152i64, 768i64, 0x484955u32);

    let mut get_url = url.as_bytes().to_vec();
    get_url.push(0);
    get_url.extend_from_slice(b"_level0\0");
    let mut actions = Vec::new();
    if !quality.is_empty() {
        actions.extend(set_quality(quality));
    }
    actions.extend(action(ACTION_GET_URL, &get_url));
    actions.push(0);

    let mut tags = Vec::new();
    tags.extend(tag(TAG_FILE_ATTRIBUTES, &[0x01 | render_flag, 0, 0, 0]));
    tags.extend(tag(
        TAG_SET_BACKGROUND_COLOR,
        &[(background >> 16) as u8, (background >> 8) as u8, background as u8],
    ));
    tags.extend(tag(TAG_DO_ACTION, &actions));
    tags.extend(tag(TAG_SHOW_FRAME, &[]));
    tags.extend(tag(TAG_END, &[]));

    let mut frame = rect(0, width * 20, 0, height * 20);
    frame.extend_from_slice(&[0x00, 24, 1, 0]);

    let mut out = b"FWS".to_vec();
    out.push(10);
    out.extend_from_slice(&((8 + frame.len() + tags.len()) as u32).to_le_bytes());
    out.extend(frame);
    out.extend(tags);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_and_length() {
        let swf = build("http://dungeonblitzr.theminesa.studio/p/cbp/DungeonBlitz.swf", "direct", "LOW").unwrap();
        assert_eq!(&swf[0..3], b"FWS");
        assert_eq!(u32::from_le_bytes([swf[4], swf[5], swf[6], swf[7]]) as usize, swf.len());
        assert!(build("x", "bogus", "").is_err());
    }

    #[test]
    fn rect_matches_node() {
        assert_eq!(hex::encode(rect(0, 1152 * 20, 0, 768 * 20)), "800002d0000001e000");
        assert_eq!(
            hex::encode(build("http://a/b.swf", "direct", "LOW").unwrap()),
            "4657530a51000000800002d0000001e0000018010044114100000043024849552b03960c0000000100009841004c4f570023831700687474703a2f2f612f622e737766005f6c6576656c30000040000000"
        );
    }
}
